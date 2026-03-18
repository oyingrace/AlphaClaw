;; AlphaClaw testnet swap contract (USDCx <-> STX).
;;
;; This is intentionally minimal for demo purposes:
;; - The caller must first transfer the input asset into this contract (liquidity model).
;; - The contract then sends the output asset back to the caller based on an amount provided by the caller.
;;
;; Notes on transaction context:
;; - We use `as-contract` when moving STX / calling token transfer so that the contract is treated as the spend source.

(define-constant ERR_ZERO_AMOUNT u100)

;; USDCx SIP-010 token contract on Stacks.
;; The FX agent currently references the USDCx address from shared token config.
;; Swap USDCx that the caller has already transferred into this contract into STX.
;; Parameters are:
;; - usdcx-amount: amount of USDCx expected to be already in the contract
;; - stx-amount: exact amount of STX to send out
(define-public (swap-usdcx-to-stx (usdcx-amount uint) (stx-amount uint))
  (begin
    (asserts! (> usdcx-amount u0) (err ERR_ZERO_AMOUNT))
    (asserts! (> stx-amount u0) (err ERR_ZERO_AMOUNT))
    ;; Capture the original caller; `as-contract?` will change `tx-sender`.
    (let ((caller tx-sender))
      (begin
        ;; Ensure we have enough STX liquidity to pay out.
        (asserts! (>= (stx-get-balance current-contract) stx-amount) (err u201))

        ;; Send STX from this contract to the original caller.
        ;; Use `as-contract?` so that `tx-sender` becomes this contract principal.
        (asserts!
          (is-ok
            (as-contract? ((with-stx stx-amount))
              (try! (stx-transfer? stx-amount tx-sender caller))))
          (err u200))

        (ok true)
      )
    )
  )
)

;; Basic debug helper: current STX balance of this contract.
(define-read-only (get-stx-balance)
  (stx-get-balance current-contract)
)

