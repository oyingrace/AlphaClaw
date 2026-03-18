;; AlphaClaw testnet staking demo (v9 - non-custodial)
;; Track stake amounts and mint rewards without moving STX into/out of the contract.

;; -----------------------------
;; TRAITS / CONSTANTS
;; -----------------------------

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

;; Per-user stake data (pure accounting, no custodial STX)
(define-map stakes
  { staker: principal }
  {
    amount: uint,
    last-claim: uint
  }
)

;; -----------------------------
;; READ-ONLY HELPERS
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

;; Debug helper: inspect the virtual stake state for a given user.
;; This is read-only and does not modify any state.
(define-read-only (debug-stake (user principal))
  (let (
        (position (map-get? stakes { staker: user }))
       )
    (match position
      position-data
      (let (
            (amount (get amount position-data))
            (last-claim (get last-claim position-data))
            (current-time (now))
            (rewards (calculate-rewards amount last-claim))
           )
        (ok {
          user: user,
          amount: amount,
          last-claim: last-claim,
          now: current-time,
          rewards: rewards,
          total-staked: (var-get total-staked)
        })
      )
      (err u103)
    )
  )
)

;; -----------------------------
;; PUBLIC FUNCTIONS (NON-CUSTODIAL)
;; -----------------------------

;; "Stake" by registering an amount in contract storage.
;; No STX are moved; this is pure accounting that the frontend
;; should keep in sync with the user's off-chain / UI notion of stake.
(define-public (stake (amount uint))
  (begin
    (asserts! (> amount u0) (err u100))
    (let
      (
        (prev (get-stake tx-sender))
        (prev-amount (get amount prev))
        (prev-last-claim (get last-claim prev))
        (current-time (now))
      )
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

;; Unstake and claim any pending rewards.
;; This only updates the accounting and mints rewards;
;; STX themselves are never moved by this contract.
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
          ;; Remove stake from accounting
          (map-delete stakes { staker: tx-sender })
          (var-set total-staked (- (var-get total-staked) amount))

          ;; Rewards are currently disabled; just return unstaked amount and zero rewards.
          (ok { unstaked: amount, rewards: u0 })
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
          ;; Rewards are disabled in this version.
          ;; Keep the function callable but do nothing.
          (ok u0)
        )
      )
      (err u103)
    )
  )
)

