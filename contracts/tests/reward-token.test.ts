import { Clarinet, Tx, Chain, Account } from "clarinet";
import { assertEquals, assertOk, assertUint } from "vitest";

Clarinet.test({
  name: "reward-token: owner can mint and balances update",
  async fn(chain: Chain, accounts: Map<string, Account>) {
    const deployer = accounts.get("deployer")!;
    const user = accounts.get("wallet_1")!;

    // owner-mint 100 tokens to user
    let block = chain.mineBlock([
      Tx.contractCall(
        "reward-token",
        "owner-mint",
        ["u100", `'${user.address}`],
        deployer.address,
      ),
    ]);

    const receipt = block.receipts[0].result;
    assertOk(receipt);

    // check balance
    let balance = chain.callReadOnlyFn(
      "reward-token",
      "get-balance",
      [`'${user.address}`],
      deployer.address,
    );
    assertOk(balance);
    assertUint(100, balance);
  },
});