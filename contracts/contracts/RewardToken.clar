;; -----------------------------
;; CONSTANTS / TYPES
;; -----------------------------

(define-constant ERR_NOT_OWNER u100)
(define-constant ERR_NOT_MINTER u101)
(define-constant ERR_INSUFFICIENT_BALANCE u102)
(define-constant ERR_ZERO_AMOUNT u103)

;; -----------------------------
;; DATA
;; -----------------------------

;; Deployer of this contract
(define-data-var owner principal tx-sender)

;; Address allowed to mint new tokens (should be set to the staking contract)
(define-data-var minter (optional principal) none)

;; Total token supply
(define-data-var total-supply uint u0)

;; Balances
(define-map balances
  { account: principal }
  { balance: uint }
)

;; -----------------------------
;; INTERNAL HELPERS
;; -----------------------------

(define-read-only (is-owner (who principal))
  (is-eq who (var-get owner))
)

(define-read-only (is-minter (who principal))
  (match (var-get minter)
    minter-principal (is-eq who minter-principal)
    false
  )
)

(define-private (mint-internal (to principal) (amount uint))
  (begin
    (asserts! (> amount u0) (err ERR_ZERO_AMOUNT))
    (let
      (
        (current (default-to { balance: u0 } (map-get? balances { account: to })))
        (new-balance (+ (get balance current) amount))
      )
      (map-set balances { account: to } { balance: new-balance })
      (var-set total-supply (+ (var-get total-supply) amount))
      (ok true)
    )
  )
)

;; -----------------------------
;; OWNER / ADMIN FUNCTIONS
;; -----------------------------

;; Set the minter address, typically to the staking contract principal.
(define-public (set-minter (new-minter principal))
  (begin
    (asserts! (is-owner tx-sender) (err ERR_NOT_OWNER))
    (var-set minter (some new-minter))
    (ok new-minter)
  )
)

;; Optional: owner can mint initial supply (e.g. for seeding liquidity, testing, etc.)
(define-public (owner-mint (to principal) (amount uint))
  (begin
    (asserts! (is-owner tx-sender) (err ERR_NOT_OWNER))
    (mint-internal to amount)
  )
)

;; -----------------------------
;; MINTER (STAKING CONTRACT) FUNCTION
;; -----------------------------

;; Mint new tokens to a recipient. Intended caller: staking contract.
(define-public (mint (to principal) (amount uint))
  (begin
    (asserts! (is-minter tx-sender) (err ERR_NOT_MINTER))
    (mint-internal to amount)
  )
)

;; -----------------------------
;; SIP-010 STANDARD IMPLEMENTATION
;; -----------------------------

;; Implement the sip-010-ft-trait

(define-read-only (get-name)
  (ok "AlphaClaw Reward Token")
)

(define-read-only (get-symbol)
  (ok "AC-RWD")
)

(define-read-only (get-decimals)
  (ok u6)
)

(define-read-only (get-balance (who principal))
  (ok (default-to u0 (get balance (default-to { balance: u0 } (map-get? balances { account: who })))))
)

(define-read-only (get-total-supply)
  (ok (var-get total-supply))
)

(define-read-only (get-token-uri)
  (ok (some "https://alphaclaw.example/reward-token-metadata.json"))
)

;; Standard transfer: move tokens from `sender` to `recipient`.
(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
  (begin
    (asserts! (> amount u0) (err ERR_ZERO_AMOUNT))
    (let
      (
        (from-bal (default-to { balance: u0 } (map-get? balances { account: sender })))
      )
      (begin
        (asserts! (>= (get balance from-bal) amount) (err ERR_INSUFFICIENT_BALANCE))

        ;; Decrease sender balance
        (map-set balances { account: sender } { balance: (- (get balance from-bal) amount) })

        ;; Increase recipient balance
        (let
          (
            (to-bal (default-to { balance: u0 } (map-get? balances { account: recipient })))
          )
          (map-set balances { account: recipient } { balance: (+ (get balance to-bal) amount) })
        )

        (ok true)
      )
    )
  )
)

;; NOTE: We intentionally omit `impl-trait` here because the SIP-010
;; trait is defined locally in this file rather than as an external
;; trait contract, and `impl-trait` in this context causes a VM error.
