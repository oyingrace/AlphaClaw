;; AlphaClaw testnet staking demo
;; Stake testnet STX and earn a simple APR in a reward token

;; -----------------------------
;; TRAITS / CONSTANTS
;; -----------------------------

;; SIP-010 fungible token trait (standard, testnet)
;; https://explorer.stacks.co/txid/ST1NXBK3K5YYMD6FD41MVNP3JS1GABZ8TRVX023PT.sip-010-trait-ft-standard?chain=testnet
(use-trait sip010-ft-trait 'ST1NXBK3K5YYMD6FD41MVNP3JS1GABZ8TRVX023PT.sip-010-trait-ft-standard.sip-010-trait)

;; The principal of the local reward token contract (simnet).
(define-constant REWARD-TOKEN .RewardToken)

;; Annual percentage rate expressed in basis points (1% = 100 bp)
;; Example: 1000 = 10% APR
(define-constant APR-BASIS-POINTS u1000)

;; Number of seconds per year (approx)
(define-constant SECONDS-PER-YEAR u31557600)

;; Scaling factor to preserve precision in reward calculations
(define-constant SCALE u1000000)

;; -----------------------------
;; DATA
;; -----------------------------

(define-data-var total-staked uint u0)

;; Per-user stake data
(define-map stakes
  { staker: principal }
  {
    amount: uint,
    last-claim: uint
  }
)

;; -----------------------------
;; HELPERS
;; -----------------------------

(define-read-only (get-total-staked)
  (var-get total-staked)
)

(define-read-only (get-stake (user principal))
  (default-to
    { amount: u0, last-claim: u0 }
    (map-get? stakes { staker: user })
  )
)

(define-read-only (now)
  ;; Clarity 4: approximate wall-clock time using stacks-block-height.
  ;; Each burn block is treated as ~600 seconds for reward accrual.
  (* stacks-block-height u600)
)

;; Calculate rewards for a given stake amount and last-claim timestamp.
;; Simple APR with linear accrual:
;; rewards = amount * APR(bp) * elapsed-seconds / (SECONDS-PER-YEAR * 10_000)
(define-read-only (calculate-rewards (amount uint) (last-claim uint))
  (let
    (
      (current-time (now))
      (elapsed (if (> current-time last-claim)
                  (- current-time last-claim)
                  u0))
      (numerator (* amount APR-BASIS-POINTS elapsed))
      (denominator (* SECONDS-PER-YEAR u10000))
    )
    (if (is-eq denominator u0)
        u0
        (/ (* numerator SCALE) denominator)
    )
  )
)

(define-read-only (calculate-apr)
  APR-BASIS-POINTS
)

;; Helper: return the reward token contract principal
(define-read-only (reward-token)
  REWARD-TOKEN
)

;; -----------------------------
;; PUBLIC FUNCTIONS
;; -----------------------------

;; Stake STX into the contract.
;; The contract pulls STX from the caller into its own balance using `stx-transfer?`,
;; then records / updates the stake position.
(define-public (stake (amount uint))
  (begin
    (asserts! (> amount u0) (err u100))
    ;; Move STX from the user (tx-sender) into the contract's balance by
    ;; transferring to this contract's principal.
    (asserts!
      (is-ok (stx-transfer? amount tx-sender 'ST1HGXPGWSHPHW3PNC66FWQ5VG1PFNYKBCSCQ7WMJ.alphaclaw-stake-v3))
      (err u200))
    (let
      (
        (prev (get-stake tx-sender))
        (prev-amount (get amount prev))
        (prev-last-claim (get last-claim prev))
        (current-time (now))
      )
      ;; If user already has a stake, first accrue rewards up to now
      (let
        (
          (new-amount (+ prev-amount amount))
          (new-last-claim (if (> prev-amount u0) prev-last-claim current-time))
        )
        (begin
          (map-set stakes
            { staker: tx-sender }
            {
              amount: new-amount,
              last-claim: new-last-claim
            }
          )
          (var-set total-staked (+ (var-get total-staked) amount))
          (ok true)
        )
      )
    )
  )
)

;; Unstake full amount and claim any pending rewards.
(define-public (unstake)
  (let
    (
      (position (map-get? stakes { staker: tx-sender }))
    )
    (match position
      position-data
      (let
        (
          (amount (get amount position-data))
          (last-claim (get last-claim position-data))
          (rewards (calculate-rewards amount last-claim))
        )
        (begin
          ;; Remove stake
          (map-delete stakes { staker: tx-sender })
          (var-set total-staked (- (var-get total-staked) amount))

          ;; Return staked STX from this contract back to the user.
          (asserts!
            (is-ok
              (stx-transfer? amount 'ST1HGXPGWSHPHW3PNC66FWQ5VG1PFNYKBCSCQ7WMJ.alphaclaw-stake-v3 tx-sender))
            (err u200))

          ;; Mint / transfer rewards
          (if (> rewards u0)
              (begin
                (asserts!
                  (is-ok (contract-call? REWARD-TOKEN transfer rewards tx-sender tx-sender none))
                  (err u201))
                (ok { unstaked: amount, rewards: rewards })
              )
              (ok { unstaked: amount, rewards: u0 })
          )
        )
      )
      (err u103)
    )
  )
)

;; Claim rewards without unstaking.
(define-public (claim-rewards)
  (let
    (
      (position (map-get? stakes { staker: tx-sender }))
    )
    (match position
      position-data
      (let
        (
          (amount (get amount position-data))
          (last-claim (get last-claim position-data))
          (rewards (calculate-rewards amount last-claim))
          (current-time (now))
        )
        (begin
          (asserts! (> rewards u0) (err u300))

          ;; Update last-claim timestamp
          (map-set stakes
            { staker: tx-sender }
            {
              amount: amount,
              last-claim: current-time
            }
          )

          ;; Mint / transfer rewards
          (asserts!
            (is-ok (contract-call? REWARD-TOKEN transfer rewards tx-sender tx-sender none))
            (err u201))

          (ok rewards)
        )
      )
      (err u103)
    )
  )
)

