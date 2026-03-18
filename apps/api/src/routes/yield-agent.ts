import { createSupabaseAdmin, type Database } from "@alphaclaw/db";
import {
	DEFAULT_YIELD_GUARDRAILS,
	frequencyToMs,
	parseFrequencyToMs,
	type RiskProfile,
} from "@alphaclaw/shared";
import type { FastifyInstance } from "fastify";
import { deriveStacksServerWallet } from "../lib/stacks-server-wallet.js";
import { authMiddleware } from "../middleware/auth.js";
import { runAgentCycle } from "../services/agent-cron.js";
import {
	getAttestationById,
	getLatestAttestationSummary,
	listAttestations,
} from "../services/attestation-service.js";
import { getWalletBalances } from "../services/dune-balances.js";
import {
	fetchClaimableRewards,
	fetchYieldOpportunities,
} from "../services/merkl-client.js";
import { STACKS_CONTRACTS } from "@alphaclaw/shared";
import { getStakingContractStake } from "../lib/stacks-read.js";
import { getTokenPriceUsd } from "../services/price-service.js";
import { executeYieldWithdraw } from "../services/yield-executor.js";
import {
	clearYieldPositionAfterWithdraw,
	fullSyncYieldPositionsFromChain,
	syncYieldPositionsFromChain,
} from "../services/yield-position-tracker.js";

type AgentConfigRow = Database["public"]["Tables"]["agent_configs"]["Row"];
type AgentTimelineRow = Database["public"]["Tables"]["agent_timeline"]["Row"];

const supabaseAdmin = createSupabaseAdmin(
	process.env.SUPABASE_URL!,
	process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function yieldAgentRoutes(app: FastifyInstance) {
	// GET /api/yield-agent/status
	app.get(
		"/api/yield-agent/status",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const walletAddress = request.user?.walletAddress;
			if (!walletAddress) return reply.status(401).send({ error: "Unauthorized" });

			const { data, error } = await supabaseAdmin
				.from("agent_configs")
				.select("*")
				.eq("wallet_address", walletAddress)
				.eq("agent_type", "yield")
				.single();

			const config = data as AgentConfigRow | null;

			if (error || !config) {
				return reply.status(404).send({ error: "Yield agent not configured" });
			}

			// Count today's trades
			const todayStart = new Date();
			todayStart.setHours(0, 0, 0, 0);

			const { count: tradesToday } = await supabaseAdmin
				.from("yield_agent_timeline")
				.select("*", { count: "exact", head: true })
				.eq("wallet_address", walletAddress)
				.eq("event_type", "trade" as AgentTimelineRow["event_type"])
				.gte("created_at", todayStart.toISOString());

			// Count yield positions
			const { count: positionCount } = await supabaseAdmin
				.from("yield_positions")
				.select("*", { count: "exact", head: true })
				.eq("wallet_address", walletAddress)
				.gt("lp_shares", 0);

			return {
				config: {
					id: config.id,
					active: config.active,
					frequency: config.frequency,
					serverWalletAddress: config.server_wallet_address,
					lastRunAt: config.last_run_at,
					nextRunAt: config.next_run_at,
					strategyParams: config.strategy_params,
				},
				tradesToday: tradesToday ?? 0,
				positionCount: positionCount ?? 0,
			};
		},
	);

	// GET /api/yield-agent/positions
	app.get(
		"/api/yield-agent/positions",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const walletAddress = request.user?.walletAddress;
			if (!walletAddress) return reply.status(401).send({ error: "Unauthorized" });

			const { data, error } = await supabaseAdmin
				.from("yield_positions")
				.select("*")
				.eq("wallet_address", walletAddress)
				.gt("lp_shares", 0)
				.order("deposit_amount_usd", { ascending: false });

			if (error) {
				return reply
					.status(500)
					.send({ error: "Failed to fetch yield positions" });
			}

			// Enrich positions with current USD value.
			// - For most vaults: use on-chain wallet balances (token value).
			// - For testnet AlphaClaw staking: use staking contract state (staked STX * price).
			const valueByTokenAddress = new Map<string, number>();
			const valueByTokenSymbol = new Map<string, number>();
			let testnetStakingValueUsd: number | null = null;
			try {
				const { data: configData } = await supabaseAdmin
					.from("agent_configs")
					.select("server_wallet_address")
					.eq("wallet_address", walletAddress)
					.eq("agent_type", "yield")
					.single();
				const serverWalletAddress = configData?.server_wallet_address as string | undefined;
				if (serverWalletAddress) {
					const balances = await getWalletBalances(serverWalletAddress);
					for (const b of balances) {
						if (b.address) {
							valueByTokenAddress.set(b.address.toLowerCase(), b.value_usd);
						}
						if (b.symbol) {
							valueByTokenSymbol.set(b.symbol.toUpperCase(), b.value_usd);
						}
					}

					// Testnet AlphaClaw staking: derive value from staking contract state, not wallet STX balance.
					if (STACKS_CONTRACTS.network === "testnet" && STACKS_CONTRACTS.stakingContractId) {
						const { amount } = await getStakingContractStake(serverWalletAddress);
						if (amount > 0n) {
							const stxPrice = await getTokenPriceUsd("STX");
							testnetStakingValueUsd =
								(Number(amount) / 10 ** 6) * (Number.isFinite(stxPrice) && stxPrice > 0 ? stxPrice : 0);
						}
					}
				}
			} catch {
				// If enrichment fails, we still return base positions; currentValueUsd will just be undefined.
			}

			return {
				positions: (data ?? []).map((p: Record<string, unknown>) => {
					const depositToken = (p.deposit_token as string | undefined) ?? "";
					const depositTokenAddress = depositToken;

					// Testnet AlphaClaw staking position: use staking contract-derived value, avoid double-counting wallet STX.
					const vaultAddress = (p.vault_address as string | undefined) ?? "";
					const isTestnetStakingVault =
						STACKS_CONTRACTS.network === "testnet" &&
						STACKS_CONTRACTS.stakingContractId &&
						vaultAddress.toLowerCase() === STACKS_CONTRACTS.stakingContractId.toLowerCase();

					let currentValueUsd: number | null;
					if (isTestnetStakingVault && testnetStakingValueUsd != null) {
						currentValueUsd = testnetStakingValueUsd;
					} else {
						// Default path: derive from wallet token balances.
						// Try to match by exact token address first, then by symbol (e.g. stSTX).
						currentValueUsd =
							valueByTokenAddress.get(depositTokenAddress.toLowerCase()) ??
							valueByTokenSymbol.get(depositToken.toUpperCase()) ??
							null;
					}

					return {
						id: p.id,
						vaultAddress: p.vault_address,
						protocol: p.protocol,
						lpShares: p.lp_shares,
						depositToken: p.deposit_token,
						depositAmountUsd: p.deposit_amount_usd,
						depositedAt: p.deposited_at,
						currentApr: p.current_apr,
						lastCheckedAt: p.last_checked_at,
						currentValueUsd,
					};
				}),
			};
		},
	);

	// GET /api/yield-agent/opportunities
	app.get(
		"/api/yield-agent/opportunities",
		{ preHandler: authMiddleware },
		async (_request, reply) => {
			try {
				const opportunities = await fetchYieldOpportunities();
				return { opportunities };
			} catch (err) {
				console.error("Failed to fetch yield opportunities:", err);
				return reply
					.status(500)
					.send({ error: "Failed to fetch yield opportunities" });
			}
		},
	);

	// GET /api/yield-agent/rewards
	app.get(
		"/api/yield-agent/rewards",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const walletAddress = request.user?.walletAddress;
			if (!walletAddress) return reply.status(401).send({ error: "Unauthorized" });

			const { data: configData, error: configError } = await supabaseAdmin
				.from("agent_configs")
				.select("server_wallet_address")
				.eq("wallet_address", walletAddress)
				.eq("agent_type", "yield")
				.single();

			if (configError || !configData?.server_wallet_address) {
				return reply
					.status(404)
					.send({ error: "Yield agent wallet not configured" });
			}

			try {
				const rewards = await fetchClaimableRewards(
					configData.server_wallet_address,
				);
				return { rewards };
			} catch (err) {
				console.error("Failed to fetch claimable rewards:", err);
				return reply.status(500).send({ error: "Failed to fetch rewards" });
			}
		},
	);

	// POST /api/yield-agent/register
	app.post(
		"/api/yield-agent/register",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const walletAddress = request.user?.walletAddress;
			if (!walletAddress) return reply.status(401).send({ error: "Unauthorized" });
			const body = request.body as {
				riskProfile: string;
				frequency: number;
				autoCompound: boolean;
			};

			if (
				!body.riskProfile ||
				!["conservative", "moderate", "aggressive"].includes(body.riskProfile)
			) {
				return reply
					.status(400)
					.send({
						error:
							"Invalid riskProfile. Must be conservative, moderate, or aggressive.",
					});
			}

			if (
				!body.frequency ||
				typeof body.frequency !== "number" ||
				body.frequency < 1 ||
				body.frequency > 24
			) {
				return reply
					.status(400)
					.send({ error: "frequency must be a number between 1 and 24" });
			}

			// Check if yield agent already exists
			const { data: existing } = await supabaseAdmin
				.from("agent_configs")
				.select("id")
				.eq("wallet_address", walletAddress)
				.eq("agent_type", "yield")
				.single();

			if (existing) {
				return reply
					.status(409)
					.send({ error: "Yield agent already registered" });
			}

			// Create server wallet for yield agent (Stacks: derived from STACKS_AGENT_MASTER_SECRET)
			const identifier = `agent-yield-${walletAddress.toLowerCase()}`;
			let walletResult: { address: string };
			try {
				const { address } = deriveStacksServerWallet(identifier);
				walletResult = { address };
			} catch (err) {
				console.error("Failed to create yield agent wallet:", err);
				return reply
					.status(500)
					.send({ error: "Failed to create agent wallet" });
			}

			// Build default guardrails from risk profile
			const riskProfile = body.riskProfile as RiskProfile;
			const guardrails = DEFAULT_YIELD_GUARDRAILS[riskProfile];
			const strategyParams = {
				...guardrails,
				autoCompound: body.autoCompound ?? guardrails.autoCompound,
			};

			const freqMs = frequencyToMs(body.frequency);
			const nextRunAt = new Date(Date.now() + freqMs).toISOString();

			const { data: configData, error: upsertError } = await supabaseAdmin
				.from("agent_configs")
				.upsert(
					{
						wallet_address: walletAddress,
						agent_type: "yield",
						active: false,
						frequency: String(body.frequency),
						server_wallet_id: identifier,
						server_wallet_address: walletResult.address,
						strategy_params: strategyParams,
						next_run_at: nextRunAt,
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
					},
					{ onConflict: "wallet_address,agent_type" },
				)
				.select("id")
				.single();

			if (upsertError || !configData) {
				console.error("Failed to upsert yield agent config:", upsertError);
				return reply
					.status(500)
					.send({ error: "Failed to create yield agent" });
			}

			return {
				serverWalletAddress: walletResult.address,
				configId: configData.id,
			};
		},
	);

	// POST /api/yield-agent/toggle
	app.post(
		"/api/yield-agent/toggle",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const walletAddress = request.user?.walletAddress;
			if (!walletAddress) return reply.status(401).send({ error: "Unauthorized" });

			// Get current state
			const { data: configData, error: fetchError } = await supabaseAdmin
				.from("agent_configs")
				.select("id, active, frequency, next_run_at")
				.eq("wallet_address", walletAddress)
				.eq("agent_type", "yield")
				.single();

			const config = configData as Pick<
				AgentConfigRow,
				"id" | "active" | "frequency" | "next_run_at"
			> | null;

			if (fetchError || !config) {
				return reply.status(404).send({ error: "Yield agent not configured" });
			}

			const newActive = !config.active;

			const updates: Record<string, unknown> = {
				active: newActive,
				updated_at: new Date().toISOString(),
			};

			// When activating, only set next_run_at if there isn't a valid future one
			if (newActive) {
				const existingNextRun = config.next_run_at
					? new Date(config.next_run_at).getTime()
					: 0;
				const hasValidFutureRun = existingNextRun > Date.now();

				if (!hasValidFutureRun) {
					const freqMs = parseFrequencyToMs(config.frequency);
					updates.next_run_at = new Date(Date.now() + freqMs).toISOString();
				}
			}

			const { error } = await supabaseAdmin
				.from("agent_configs")
				.update(updates)
				.eq("id", config.id);

			if (error) {
				return reply
					.status(500)
					.send({ error: "Failed to toggle yield agent" });
			}

			return { active: newActive };
		},
	);

	// POST /api/yield-agent/run-now — trigger an immediate yield agent cycle
	app.post(
		"/api/yield-agent/run-now",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const walletAddress = request.user?.walletAddress;
			if (!walletAddress) return reply.status(401).send({ error: "Unauthorized" });

			const { data: configData, error: fetchError } = await supabaseAdmin
				.from("agent_configs")
				.select("*")
				.eq("wallet_address", walletAddress)
				.eq("agent_type", "yield")
				.single();

			const config = configData as AgentConfigRow | null;

			if (fetchError || !config) {
				return reply.status(404).send({ error: "Yield agent not configured" });
			}

			if (!config.server_wallet_address || !config.server_wallet_id) {
				return reply
					.status(400)
					.send({ error: "Yield agent wallet not set up" });
			}

			// Sync positions from chain first so we use accurate data (clears stale rows if user withdrew manually)
			await syncYieldPositionsFromChain({
				walletAddress,
				serverWalletAddress: config.server_wallet_address,
			});

			const MIN_BALANCE_USD = 3;
			try {
				const balances = await getWalletBalances(config.server_wallet_address);
				const liquidValue = balances.reduce((s, b) => s + b.value_usd, 0);
				const { data: yieldPositions } = await supabaseAdmin
					.from("yield_positions")
					.select("deposit_amount_usd")
					.eq("wallet_address", walletAddress)
					.gt("lp_shares", 0);
				const vaultValue = (yieldPositions ?? []).reduce(
					(s, p) => s + Number(p.deposit_amount_usd ?? 0),
					0,
				);
				const totalValueUsd = liquidValue + vaultValue;
				if (totalValueUsd < MIN_BALANCE_USD) {
					return reply.status(400).send({
						error: "Minimum balance of $3 required to run the agent",
						code: "INSUFFICIENT_BALANCE",
					});
				}
			} catch (balanceErr) {
				console.error("Failed to check balance for run-now:", balanceErr);
				return reply
					.status(500)
					.send({ error: "Failed to verify wallet balance" });
			}

			// Run the cycle in background — respond immediately
			runAgentCycle(config).catch((err) => {
				console.error(
					`On-demand yield agent cycle failed for ${walletAddress}:`,
					err,
				);
			});

			// Update last_run_at and next_run_at
			const freqMs = parseFrequencyToMs(config.frequency);
			const nextRun = new Date(Date.now() + freqMs).toISOString();

			await supabaseAdmin
				.from("agent_configs")
				.update({
					last_run_at: new Date().toISOString(),
					next_run_at: nextRun,
					updated_at: new Date().toISOString(),
				})
				.eq("id", config.id);

			return { triggered: true };
		},
	);

	// POST /api/yield-agent/sync-positions — discover on-chain positions and backfill yield_positions
	app.post(
		"/api/yield-agent/sync-positions",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const walletAddress = request.user?.walletAddress;
			if (!walletAddress) return reply.status(401).send({ error: "Unauthorized" });

			const { data: configData, error: configError } = await supabaseAdmin
				.from("agent_configs")
				.select("server_wallet_address")
				.eq("wallet_address", walletAddress)
				.eq("agent_type", "yield")
				.single();

			if (configError || !configData?.server_wallet_address) {
				return reply
					.status(404)
					.send({ error: "Yield agent wallet not configured" });
			}

			const opportunities = await fetchYieldOpportunities();
			const { synced, cleared } = await fullSyncYieldPositionsFromChain({
				walletAddress,
				serverWalletAddress: configData.server_wallet_address,
				opportunities,
			});

			return { synced, cleared, message: "Positions synced from chain" };
		},
	);

	// POST /api/yield-agent/withdraw-all — full exit from all vault positions
	app.post(
		"/api/yield-agent/withdraw-all",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const walletAddress = request.user?.walletAddress;
			if (!walletAddress) return reply.status(401).send({ error: "Unauthorized" });

			// Get yield agent config
			const { data: configData, error: configError } = await supabaseAdmin
				.from("agent_configs")
				.select("server_wallet_id, server_wallet_address")
				.eq("wallet_address", walletAddress)
				.eq("agent_type", "yield")
				.single();

			const config = configData as Pick<
				AgentConfigRow,
				"server_wallet_id" | "server_wallet_address"
			> | null;

			if (
				configError ||
				!config ||
				!config.server_wallet_id ||
				!config.server_wallet_address
			) {
				return reply
					.status(404)
					.send({ error: "Yield agent wallet not configured" });
			}

			// Get all positions with lp_shares > 0
			const { data: positions, error: posError } = await supabaseAdmin
				.from("yield_positions")
				.select("vault_address")
				.eq("wallet_address", walletAddress)
				.gt("lp_shares", 0);

			if (posError) {
				return reply.status(500).send({ error: "Failed to fetch positions" });
			}

			if (!positions || positions.length === 0) {
				return { results: [], message: "No active positions to withdraw" };
			}

			const results = [];
			for (const pos of positions) {
				const vaultAddress = String(pos.vault_address);
				try {
					const result = await executeYieldWithdraw({
						serverWalletId: config.server_wallet_id,
						serverWalletAddress: config.server_wallet_address,
						vaultAddress,
					});
					if (result.success) {
						await clearYieldPositionAfterWithdraw({
							walletAddress,
							vaultAddress: pos.vault_address as string,
						});
					}
					if (!result.success && result.error?.toLowerCase().includes("no ") && result.error?.toLowerCase().includes(" to withdraw")) {
						await clearYieldPositionAfterWithdraw({
							walletAddress,
							vaultAddress: pos.vault_address as string,
						});
						results.push({
							vaultAddress,
							txHash: null,
							success: true,
							skipped: true,
							message: "No on-chain position; cleared stale DB row",
						});
					} else {
						results.push({
							vaultAddress,
							txHash: result.txHash ?? null,
							success: result.success,
							error: result.error ?? null,
							skipped: false,
						});
					}
				} catch (err) {
					results.push({
						vaultAddress,
						txHash: null,
						success: false,
						error: err instanceof Error ? err.message : String(err),
						skipped: false,
					});
				}
			}

			return { results };
		},
	);

	// PUT /api/yield-agent/settings
	app.put(
		"/api/yield-agent/settings",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const walletAddress = request.user?.walletAddress;
			if (!walletAddress) return reply.status(401).send({ error: "Unauthorized" });
			const body = request.body as {
				frequency?: number;
				minAprThreshold?: number;
				maxSingleVaultPct?: number;
				minHoldPeriodDays?: number;
				maxIlTolerancePct?: number;
				minTvlUsd?: number;
				maxVaultCount?: number;
				rewardClaimFrequencyHrs?: number;
				autoCompound?: boolean;
				customPrompt?: string;
			};

			// Validate frequency (1–24 integer hours). Accept number or numeric string.
			if (body.frequency !== undefined) {
				const freq =
					typeof body.frequency === "number"
						? body.frequency
						: parseInt(String(body.frequency), 10);
				if (
					Number.isNaN(freq) ||
					!Number.isInteger(freq) ||
					freq < 1 ||
					freq > 24
				) {
					return reply
						.status(400)
						.send({ error: "frequency must be an integer between 1 and 24" });
				}
				// Normalize to number so we don't persist strings.
				body.frequency = freq;
			}

			// Validate numeric ranges
			if (body.minAprThreshold !== undefined && body.minAprThreshold < 0) {
				return reply
					.status(400)
					.send({ error: "minAprThreshold must be non-negative" });
			}
			if (
				body.maxSingleVaultPct !== undefined &&
				(body.maxSingleVaultPct <= 0 || body.maxSingleVaultPct > 100)
			) {
				return reply
					.status(400)
					.send({ error: "maxSingleVaultPct must be between 0 and 100" });
			}
			if (body.minHoldPeriodDays !== undefined && body.minHoldPeriodDays < 0) {
				return reply
					.status(400)
					.send({ error: "minHoldPeriodDays must be non-negative" });
			}
			if (
				body.maxIlTolerancePct !== undefined &&
				(body.maxIlTolerancePct <= 0 || body.maxIlTolerancePct > 100)
			) {
				return reply
					.status(400)
					.send({ error: "maxIlTolerancePct must be between 0 and 100" });
			}
			if (body.minTvlUsd !== undefined && body.minTvlUsd < 0) {
				return reply
					.status(400)
					.send({ error: "minTvlUsd must be non-negative" });
			}
			if (
				body.maxVaultCount !== undefined &&
				(!Number.isInteger(body.maxVaultCount) || body.maxVaultCount < 1)
			) {
				return reply
					.status(400)
					.send({ error: "maxVaultCount must be a positive integer" });
			}
			if (
				body.rewardClaimFrequencyHrs !== undefined &&
				body.rewardClaimFrequencyHrs < 1
			) {
				return reply
					.status(400)
					.send({ error: "rewardClaimFrequencyHrs must be at least 1" });
			}

			// Get current config to merge strategy_params
			const { data: currentConfig, error: fetchError } = await supabaseAdmin
				.from("agent_configs")
				.select("id, strategy_params")
				.eq("wallet_address", walletAddress)
				.eq("agent_type", "yield")
				.single();

			if (fetchError || !currentConfig) {
				return reply.status(404).send({ error: "Yield agent not configured" });
			}

			const existingParams = (currentConfig.strategy_params ?? {}) as Record<
				string,
				unknown
			>;

			// Build updated strategy_params
			const strategyUpdates: Record<string, unknown> = { ...existingParams };
			if (body.minAprThreshold !== undefined)
				strategyUpdates.minAprThreshold = body.minAprThreshold;
			if (body.maxSingleVaultPct !== undefined)
				strategyUpdates.maxSingleVaultPct = body.maxSingleVaultPct;
			if (body.minHoldPeriodDays !== undefined)
				strategyUpdates.minHoldPeriodDays = body.minHoldPeriodDays;
			if (body.maxIlTolerancePct !== undefined)
				strategyUpdates.maxIlTolerancePct = body.maxIlTolerancePct;
			if (body.minTvlUsd !== undefined)
				strategyUpdates.minTvlUsd = body.minTvlUsd;
			if (body.maxVaultCount !== undefined)
				strategyUpdates.maxVaultCount = body.maxVaultCount;
			if (body.rewardClaimFrequencyHrs !== undefined)
				strategyUpdates.rewardClaimFrequencyHrs = body.rewardClaimFrequencyHrs;
			if (body.autoCompound !== undefined)
				strategyUpdates.autoCompound = body.autoCompound;

			// Build column-level updates
			const updates: Record<string, unknown> = {
				strategy_params: strategyUpdates,
				updated_at: new Date().toISOString(),
			};

			if (body.frequency !== undefined) updates.frequency = body.frequency;
			if (body.customPrompt !== undefined)
				updates.custom_prompt = body.customPrompt;

			const { data, error } = await supabaseAdmin
				.from("agent_configs")
				.update(updates)
				.eq("id", currentConfig.id)
				.select()
				.single();

			if (error || !data) {
				return reply
					.status(500)
					.send({ error: "Failed to update yield agent settings" });
			}

			return { success: true };
		},
	);

	// GET /api/yield-agent/attestations
	app.get(
		"/api/yield-agent/attestations",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const walletAddress = request.user?.walletAddress;
			if (!walletAddress) return reply.status(401).send({ error: "Unauthorized" });
			const query = request.query as { limit?: string; offset?: string };
			const limit = Math.min(
				100,
				Math.max(1, parseInt(query.limit || "20", 10)),
			);
			const offset = Math.max(0, parseInt(query.offset || "0", 10));

			try {
				return await listAttestations({
					walletAddress,
					agentType: "yield",
					limit,
					offset,
				});
			} catch (error) {
				console.error("Failed to list Yield attestations:", error);
				return reply
					.status(500)
					.send({ error: "Failed to fetch attestations" });
			}
		},
	);

	// GET /api/yield-agent/attestations/:id
	app.get(
		"/api/yield-agent/attestations/:id",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const walletAddress = request.user?.walletAddress;
			if (!walletAddress) return reply.status(401).send({ error: "Unauthorized" });
			const { id } = request.params as { id: string };

			try {
				const attestation = await getAttestationById({
					walletAddress,
					agentType: "yield",
					id,
				});
				if (!attestation)
					return reply.status(404).send({ error: "Attestation not found" });
				return attestation;
			} catch (error) {
				console.error("Failed to fetch Yield attestation:", error);
				return reply.status(500).send({ error: "Failed to fetch attestation" });
			}
		},
	);

	// GET /api/yield-agent/timeline
	app.get(
		"/api/yield-agent/timeline",
		{ preHandler: authMiddleware },
		async (request, reply) => {
			const walletAddress = request.user?.walletAddress;
			if (!walletAddress) return reply.status(401).send({ error: "Unauthorized" });
			const query = request.query as {
				type?: string;
				limit?: string;
				offset?: string;
			};

			const limit = Math.min(
				100,
				Math.max(1, parseInt(query.limit || "20", 10)),
			);
			const offset = Math.max(0, parseInt(query.offset || "0", 10));

			let dbQuery = supabaseAdmin
				.from("yield_agent_timeline")
				.select("*", { count: "exact" })
				.eq("wallet_address", walletAddress)
				.order("created_at", { ascending: false })
				.range(offset, offset + limit - 1);

			if (query.type) {
				dbQuery = dbQuery.eq(
					"event_type",
					query.type as AgentTimelineRow["event_type"],
				);
			}

			const { data, error, count } = await dbQuery;

			if (error) {
				return reply.status(500).send({ error: "Failed to fetch timeline" });
			}

			return {
				entries: (data ?? []).map(mapTimelineEntry),
				total: count ?? 0,
				hasMore: offset + limit < (count ?? 0),
			};
		},
	);
}

/** Map a raw DB row to a camelCase timeline entry. */
function mapTimelineEntry(row: Record<string, unknown>) {
	const rawAttestationStatus = String(row.attestation_status ?? "missing");
	const attestationStatus =
		rawAttestationStatus === "verified" ||
		rawAttestationStatus === "mock_verified"
			? "verified"
			: rawAttestationStatus === "invalid" ||
					rawAttestationStatus === "mock_invalid"
				? "invalid"
				: "missing";

	return {
		id: row.id,
		eventType: row.event_type,
		summary: row.summary,
		detail: row.detail,
		citations: row.citations,
		confidencePct: row.confidence_pct,
		currency: row.currency,
		amountUsd: row.amount_usd,
		direction: row.direction,
		txHash: row.tx_hash,
		runId: row.run_id ?? null,
		attestationId: row.attestation_id ?? null,
		attestationStatus,
		createdAt: row.created_at,
	};
}
