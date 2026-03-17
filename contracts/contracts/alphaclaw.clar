;; AlphaClaw testnet staking demo
;; Stake testnet STX and earn a simple APR in a reward token

;; -----------------------------
;; TRAITS / CONSTANTS
;; -----------------------------

;; SIP-010 fungible token trait (standard)
(use-trait sip010-ft-trait 'SP2C2PYZDXQ8V4C6G2X2R7K5ZVYFAYX0P8D3G0M6.sip-010-ft-trait.sip-010-ft-trait)

;; The principal of the reward token contract on testnet.
;; TODO: replace with your deployed testnet token contract.
(define-constant REWARD-TOKEN <reward-token-contract-principal>)

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
  (unwrap-panic (get-block-info? time))
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

;; Cast the REWARD-TOKEN constant to the SIP-010 trait
(define-read-only (reward-token)
  (as-contract REWARD-TOKEN)
)

;; -----------------------------
;; PUBLIC FUNCTIONS
;; -----------------------------

;; Stake STX into the contract.
;; Users must send STX along with this call; the amount is taken from tx-sender's
;; STX transfer to the contract (amount parameter is for explicitness / sanity check).
(define-public (stake (amount uint))
  (begin
    (asserts! (> amount u0) (err u100))

    ;; Sanity: require that exactly `amount` STX were sent to this contract.
    (let
      (
        (sent (stx-get-transfer-amount tx-sender (as-contract tx-sender)))
      )
      (asserts! (is-some sent) (err u101))
      (asserts! (is-eq (unwrap-panic sent) amount) (err u102))
    )

    (let
      (
        (prev (get-stake tx-sender))
        (prev-amount (get prev amount))
        (prev-last-claim (get prev last-claim))
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

          ;; Return staked STX
          (asserts! (is-ok (stx-transfer? amount (as-contract tx-sender) tx-sender)) (err u200))

          ;; Mint / transfer rewards
          (if (> rewards u0)
              (let
                (
                  (token (reward-token))
                )
                (asserts!
                  (is-ok (contract-call? token transfer rewards (as-contract tx-sender) tx-sender none))
                  (err u201)
                )
              )
              (ok true)
          )

          (ok { unstaked: amount, rewards: rewards })
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
          (let
            (
              (token (reward-token))
            )
            (asserts!
              (is-ok (contract-call? token transfer rewards (as-contract tx-sender) tx-sender none))
              (err u201)
            )
          )

          (ok rewards)
        )
      )
      (err u103)
    )
  )
)

