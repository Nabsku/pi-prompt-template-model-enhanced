import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { extractChainContextFlag, extractLoopCount, extractLoopFlags, extractSubagentOverride, parseCommandArgs, type SubagentOverride } from "./args.js";
import { parseChainSteps, parseChainDeclaration, type ChainStep, type ChainStepOrParallel, type ParallelChainStep } from "./chain-parser.js";
import { generateChainStepSummary, generateIterationSummary, didIterationMakeChanges, getIterationEntries, wasIterationAborted } from "./loop-utils.js";
import { notify, summarizePromptDiagnostics, diagnosticsFingerprint } from "./notifications.js";
import { preparePromptExecution } from "./prompt-execution.js";
import { buildPromptCommandDescription, expandCwdPath, loadPromptsWithModel, readSkillContent, resolveSkillPath, type PromptWithModel } from "./prompt-loader.js";
import { renderSkillLoaded, type SkillLoadedDetails } from "./skill-loaded-renderer.js";
import { createToolManager } from "./tool-manager.js";
import { executeSubagentPromptStep } from "./subagent-step.js";
import { PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE } from "./subagent-runtime.js";
import { renderDelegatedSubagentResult } from "./subagent-renderer.js";

interface LoopState {
	currentIteration: number;
	totalIterations: number | null;
	rotationLabel?: string;
}

interface FreshCollapse {
	targetId: string;
	task: string;
	iteration: number;
	totalIterations: number | null;
}

interface PendingSkillMessage {
	customType: "skill-loaded";
	content: string;
	display: true;
	details: SkillLoadedDetails;
}

type SkillMessageResolution =
	| { kind: "none" }
	| { kind: "ready"; message: PendingSkillMessage }
	| { kind: "error"; error: string };

interface ExecutionErrorState {
	hasError: boolean;
	error: unknown;
}

interface PromptStepResult {
	changed: boolean;
}

export default function promptModelExtension(pi: ExtensionAPI) {
	let prompts = new Map<string, PromptWithModel>();
	let previousModel: Model<any> | undefined;
	let previousThinking: ThinkingLevel | undefined;
	let pendingSkillMessage: PendingSkillMessage | undefined;
	let runtimeModel: Model<any> | undefined;
	let chainActive = false;
	let loopState: LoopState | null = null;
	let freshCollapse: FreshCollapse | null = null;
	let accumulatedSummaries: string[] = [];
	let lastDiagnostics = "";
	let storedCommandCtx: ExtensionCommandContext | null = null;
	const UNLIMITED_LOOP_CAP = 999;

	const toolManager = createToolManager(pi, {
		isActive: () => !!(loopState || chainActive),
		getStoredCtx: () => storedCommandCtx,
		setStoredCtx: (ctx) => {
			storedCommandCtx = ctx;
		},
		executeCommand: executeToolCommand,
	});

	function sameModel(a: Model<any> | undefined, b: Model<any> | undefined): boolean {
		if (!a || !b) return a === b;
		return a.provider === b.provider && a.id === b.id;
	}

	function getCurrentModel(ctx: Pick<ExtensionContext, "model">): Model<any> | undefined {
		return runtimeModel ?? ctx.model;
	}

	pi.registerMessageRenderer<SkillLoadedDetails>("skill-loaded", renderSkillLoaded);
	pi.registerMessageRenderer(PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE, renderDelegatedSubagentResult);

	function registerPromptCommand(name: string) {
		pi.registerCommand(name, {
			description: buildPromptCommandDescription(prompts.get(name)!),
			handler: async (args, ctx) => {
				await runPromptCommand(name, args, ctx);
			},
		});
	}

	function refreshPrompts(cwd: string, ctx?: ExtensionContext) {
		const result = loadPromptsWithModel(cwd);
		prompts = result.prompts;

		for (const name of prompts.keys()) {
			registerPromptCommand(name);
		}

		const summary = summarizePromptDiagnostics(result.diagnostics);
		const fingerprint = diagnosticsFingerprint(result.diagnostics);
		if (summary && fingerprint !== lastDiagnostics) {
			notify(ctx, summary, "warning");
		}
		lastDiagnostics = fingerprint;
	}

	function consumePendingSkillMessage() {
		if (!pendingSkillMessage) return undefined;
		const message = pendingSkillMessage;
		pendingSkillMessage = undefined;
		return message;
	}

	function normalizeSkillName(skillName: string): string {
		return skillName.startsWith("skill:") ? skillName.slice("skill:".length) : skillName;
	}

	function isPathResolvableSkillName(skillName: string): boolean {
		if (skillName === "." || skillName === "..") return false;
		if (skillName.includes("/")) return false;
		if (skillName.includes("\\")) return false;
		return true;
	}

	function resolveRegisteredSkillPath(skillName: string): string | undefined {
		const normalizedSkillName = normalizeSkillName(skillName);
		if (!normalizedSkillName) return undefined;
		const candidates = new Set([normalizedSkillName, `skill:${normalizedSkillName}`]);

		for (const command of pi.getCommands()) {
			if (command.source !== "skill") continue;
			if (!command.sourceInfo.path) continue;
			if (!candidates.has(command.name)) continue;
			return command.sourceInfo.path;
		}

		return undefined;
	}

	function resolveSkillMessage(skillName: string | undefined, cwd: string): SkillMessageResolution {
		if (!skillName) {
			return { kind: "none" };
		}

		const normalizedSkillName = normalizeSkillName(skillName);
		if (!normalizedSkillName) {
			return { kind: "error", error: `Skill "${skillName}" not found` };
		}

		const skillPath =
			resolveRegisteredSkillPath(skillName) ?? (isPathResolvableSkillName(normalizedSkillName) ? resolveSkillPath(normalizedSkillName, cwd) : undefined);
		if (!skillPath) {
			return { kind: "error", error: `Skill "${skillName}" not found` };
		}

		try {
			const skillContent = readSkillContent(skillPath);
			return {
				kind: "ready",
				message: {
					customType: "skill-loaded",
					content: `<skill name="${normalizedSkillName}">\n${skillContent}\n</skill>`,
					display: true,
					details: { skillName: normalizedSkillName, skillContent, skillPath },
				},
			};
		} catch (error) {
			return {
				kind: "error",
				error: `Failed to read skill "${skillName}": ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	async function waitForTurnStart(ctx: ExtensionContext) {
		while (ctx.isIdle()) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	function shouldDelegatePrompt(prompt: PromptWithModel, override?: SubagentOverride): boolean {
		return prompt.subagent !== undefined || override?.enabled === true;
	}

	function isParallelChainStep(step: ChainStepOrParallel): step is ParallelChainStep {
		return "parallel" in step;
	}

	async function executePromptStep(
		prompt: PromptWithModel,
		args: string[],
		ctx: ExtensionCommandContext,
		currentModel: Model<any> | undefined,
		override?: SubagentOverride,
		inheritedModel?: Model<any>,
		taskPreamble?: string,
		loopContext?: string,
	): Promise<PromptStepResult | "aborted"> {
		if (shouldDelegatePrompt(prompt, override)) {
			try {
				const delegated = await executeSubagentPromptStep({
					pi,
					prompt,
					args,
					ctx,
					currentModel,
					override,
					inheritedModel,
					taskPreamble,
				});
				if (!delegated) {
					notify(ctx, `Prompt \`${prompt.name}\` is not configured for delegated execution.`, "error");
					return "aborted";
				}
				return { changed: delegated.changed };
			} catch (error) {
				notify(ctx, error instanceof Error ? error.message : String(error), "error");
				return { changed: false };
			}
		}

		const prepared =
			inheritedModel === undefined
				? await preparePromptExecution(prompt, args, currentModel, ctx.modelRegistry)
				: await preparePromptExecution(prompt, args, currentModel, ctx.modelRegistry, { inheritedModel });
		if (!prepared) {
			notify(ctx, `No available model from: ${prompt.models.join(", ")}`, "error");
			return "aborted";
		}
		if ("message" in prepared) {
			if (prepared.warning) notify(ctx, prepared.warning, "warning");
			notify(ctx, prepared.message, "error");
			return "aborted";
		}
		if (prepared.warning) {
			notify(ctx, prepared.warning, "warning");
		}

		const skillResolution = resolveSkillMessage(prompt.skill, ctx.cwd);
		if (skillResolution.kind === "error") {
			notify(ctx, skillResolution.error, "error");
			return "aborted";
		}

		if (!prepared.selectedModel.alreadyActive) {
			const switched = await pi.setModel(prepared.selectedModel.model);
			if (!switched) {
				notify(ctx, `Failed to switch to model ${prepared.selectedModel.model.provider}/${prepared.selectedModel.model.id}`, "error");
				return "aborted";
			}
			runtimeModel = prepared.selectedModel.model;
		}

		if (prompt.thinking) {
			pi.setThinkingLevel(prompt.thinking);
		}
		pendingSkillMessage = skillResolution.kind === "ready" ? skillResolution.message : undefined;

		const startId = ctx.sessionManager.getLeafId();
		const content = loopContext ? `[${loopContext}]\n\n${prepared.content}` : prepared.content;
		pi.sendUserMessage(content);
		await waitForTurnStart(ctx);
		await ctx.waitForIdle();

		const entries = getIterationEntries(ctx, startId);
		if (wasIterationAborted(entries)) return "aborted";
		return { changed: didIterationMakeChanges(entries) };
	}

	async function restoreSessionState(
		ctx: ExtensionContext,
		originalModel: Model<any> | undefined,
		originalThinking: ThinkingLevel | undefined,
		currentModel?: Model<any>,
		currentThinking?: ThinkingLevel,
	) {
		const restoredParts: string[] = [];
		const shouldRestoreThinking =
			originalThinking !== undefined && (currentThinking === undefined || currentThinking !== originalThinking);

		if (originalModel && !sameModel(originalModel, currentModel)) {
			const restoredModel = await pi.setModel(originalModel);
			if (restoredModel) {
				runtimeModel = originalModel;
				restoredParts.push(originalModel.id);
			} else {
				notify(ctx, `Failed to restore model ${originalModel.provider}/${originalModel.id}`, "error");
			}
		}
		if (shouldRestoreThinking) {
			restoredParts.push(`thinking:${originalThinking}`);
			pi.setThinkingLevel(originalThinking);
		}
		if (restoredParts.length > 0) {
			notify(ctx, `Restored to ${restoredParts.join(", ")}`, "info");
		}
	}

	async function restoreAfterExecution(
		ctx: ExtensionContext,
		shouldRestore: boolean,
		originalModel: Model<any> | undefined,
		originalThinking: ThinkingLevel | undefined,
		currentModel: Model<any> | undefined,
		currentThinking: ThinkingLevel | undefined,
		errorState: ExecutionErrorState,
		phase: "loop" | "chain",
	): Promise<ExecutionErrorState> {
		if (!shouldRestore) return errorState;

		try {
			await restoreSessionState(ctx, originalModel, originalThinking, currentModel, currentThinking);
		} catch (error) {
			if (errorState.hasError) {
				notify(
					ctx,
					`Failed to restore session state after ${phase} error: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return errorState;
			}
			return { hasError: true, error };
		}

		return errorState;
	}

	function notifyLoopCompletion(
		ctx: ExtensionContext,
		completedIterations: number,
		totalIterations: number | null,
		effectiveMax: number,
		converged: boolean,
		requireMultipleIterations: boolean,
	) {
		if (converged) {
			const convergedLabel = totalIterations !== null ? `${completedIterations}/${totalIterations}` : `${completedIterations}`;
			notify(ctx, `Loop converged at ${convergedLabel} (no changes)`, "info");
			return;
		}

		if (completedIterations === 0) return;
		if (requireMultipleIterations && effectiveMax <= 1) return;

		if (totalIterations !== null) {
			notify(ctx, `Loop finished: ${completedIterations}/${totalIterations} iterations`, "info");
			return;
		}
		if (completedIterations === effectiveMax) {
			notify(ctx, `Loop finished: ${completedIterations} iterations (cap reached)`, "info");
			return;
		}
		notify(ctx, `Loop finished: ${completedIterations} iterations`, "info");
	}

	function updateLoopStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (loopState) {
			const suffix = loopState.rotationLabel ? ` · ${loopState.rotationLabel}` : "";
			const label =
				loopState.totalIterations !== null
					? `loop ${loopState.currentIteration}/${loopState.totalIterations}${suffix}`
					: `loop ${loopState.currentIteration}${suffix}`;
			ctx.ui.setStatus("prompt-loop", ctx.ui.theme.fg("warning", label));
		} else {
			ctx.ui.setStatus("prompt-loop", undefined);
		}
	}

	async function executeToolCommand(command: string, ctx: ExtensionCommandContext) {
		const stripped = command.startsWith("/") ? command.slice(1) : command;
		const spaceIdx = stripped.indexOf(" ");
		const name = spaceIdx >= 0 ? stripped.slice(0, spaceIdx) : stripped;
		const args = spaceIdx >= 0 ? stripped.slice(spaceIdx + 1) : "";

		if (name === "chain-prompts") {
			await runChainCommand(args, ctx);
		} else {
			await runPromptCommand(name, args, ctx);
		}
	}

	async function runPromptLoop(
		name: string,
		cleanedArgs: string,
		totalIterations: number | null,
		freshFlag: boolean,
		converge: boolean,
		ctx: ExtensionCommandContext,
		subagentOverride?: SubagentOverride,
		cwdOverride?: string,
		promptOverrides?: Partial<Pick<PromptWithModel, "models" | "inheritContext">>,
	) {
		refreshPrompts(ctx.cwd, ctx);
		const initialPrompt = prompts.get(name);
		if (!initialPrompt) {
			notify(ctx, `Prompt "${name}" no longer exists`, "error");
			return;
		}

		const savedModel = getCurrentModel(ctx);
		const savedThinking = pi.getThinkingLevel();
		let currentModel = savedModel;
		let currentThinking = savedThinking;
		const shouldRestore = initialPrompt.restore;
		const useFresh = freshFlag || initialPrompt.fresh === true;
		const effectiveMax = totalIterations ?? UNLIMITED_LOOP_CAP;
		const isUnlimited = totalIterations === null;
		const useConverge = converge && initialPrompt.converge !== false;
		const anchorId = useFresh ? ctx.sessionManager.getLeafId() : null;

		loopState = { currentIteration: 1, totalIterations };
		accumulatedSummaries = [];
		updateLoopStatus(ctx);
		let completedIterations = 0;
		let converged = false;
		let loopErrorState: ExecutionErrorState = { hasError: false, error: undefined };

		try {
			for (let i = 0; i < effectiveMax; i++) {
				loopState.currentIteration = i + 1;
				const iterationLabel = totalIterations !== null ? `${i + 1}/${totalIterations}` : `${i + 1}`;

				refreshPrompts(ctx.cwd, ctx);
				const prompt = prompts.get(name);
				if (!prompt) {
					notify(ctx, `Prompt "${name}" no longer exists`, "error");
					break;
				}
				const effectivePrompt = { ...prompt, ...(cwdOverride ? { cwd: cwdOverride } : {}), ...promptOverrides };
				let iterationPrompt = effectivePrompt;
				loopState!.rotationLabel = undefined;
				if (effectivePrompt.rotate && effectivePrompt.models.length > 1) {
					const rotationIndex = i % effectivePrompt.models.length;
					const rotatedThinking = effectivePrompt.thinkingLevels
						? effectivePrompt.thinkingLevels[rotationIndex]
						: effectivePrompt.thinking;
					iterationPrompt = {
						...effectivePrompt,
						models: [effectivePrompt.models[rotationIndex]],
						thinking: rotatedThinking,
					};
					const shortModel = effectivePrompt.models[rotationIndex].split("/").pop() || effectivePrompt.models[rotationIndex];
					const thinkingLabel = rotatedThinking ? ` ${rotatedThinking}` : "";
					loopState!.rotationLabel = `${shortModel}${thinkingLabel}`;
				}
				updateLoopStatus(ctx);
				const rotationSuffix = loopState!.rotationLabel ? ` [${loopState!.rotationLabel}]` : "";
				notify(ctx, `Loop ${iterationLabel}: ${name}${rotationSuffix}`, "info");

				const loopContext = loopState!.rotationLabel
					? `Loop ${iterationLabel} · ${loopState!.rotationLabel}`
					: `Loop ${iterationLabel}`;
				const iterationStartId = ctx.sessionManager.getLeafId();
				const stepResult = await executePromptStep(
					iterationPrompt,
					parseCommandArgs(cleanedArgs),
					ctx,
					currentModel,
					subagentOverride,
					undefined,
					undefined,
					loopContext,
				);
				if (stepResult === "aborted") break;

				currentModel = getCurrentModel(ctx);
				currentThinking = pi.getThinkingLevel();
				completedIterations++;

				const iterationChanged = shouldDelegatePrompt(iterationPrompt, subagentOverride)
					? stepResult.changed
					: didIterationMakeChanges(getIterationEntries(ctx, iterationStartId));
				if (useConverge && (isUnlimited || effectiveMax > 1) && !iterationChanged) {
					converged = true;
					break;
				}

				if (anchorId && i < effectiveMax - 1) {
					freshCollapse = { targetId: anchorId, task: name, iteration: i + 1, totalIterations };
					const result = await ctx.navigateTree(anchorId, { summarize: true });
					freshCollapse = null;
					if (result.cancelled) {
						notify(ctx, "Loop cancelled", "warning");
						break;
					}
				}
			}
		} catch (error) {
			loopErrorState = { hasError: true, error };
		} finally {
			loopErrorState = await restoreAfterExecution(
				ctx,
				shouldRestore,
				savedModel,
				savedThinking,
				getCurrentModel(ctx),
				pi.getThinkingLevel(),
				loopErrorState,
				"loop",
			);

			loopState = null;
			pendingSkillMessage = undefined;
			freshCollapse = null;
			accumulatedSummaries = [];
			updateLoopStatus(ctx);

			if (!loopErrorState.hasError) {
				notifyLoopCompletion(ctx, completedIterations, totalIterations, effectiveMax, converged, false);
			}
		}

		if (loopErrorState.hasError) {
			throw loopErrorState.error;
		}
	}

	async function runSharedChainExecution(
		steps: ChainStepOrParallel[],
		sharedArgs: string[],
		totalIterations: number | null,
		fresh: boolean,
		converge: boolean,
		shouldRestore: boolean,
		ctx: ExtensionCommandContext,
		subagentOverride?: SubagentOverride,
		cwdOverride?: string,
		chainContextEnabled = false,
	) {
		const flattenChainSteps = (): ChainStep[] => {
			const flattened: ChainStep[] = [];
			for (const step of steps) {
				if (isParallelChainStep(step)) {
					flattened.push(...step.parallel);
				} else {
					flattened.push(step);
				}
			}
			return flattened;
		};

		const validateChainSteps = (): boolean => {
			const flattened = flattenChainSteps();
			const missingTemplates = flattened.filter((step) => !prompts.has(step.name));
			if (missingTemplates.length > 0) {
				notify(ctx, `Templates not found: ${missingTemplates.map((step) => step.name).join(", ")}`, "error");
				return false;
			}

			for (const step of steps) {
				if (isParallelChainStep(step)) {
					for (const parallelStep of step.parallel) {
						if (parallelStep.loopCount !== undefined) {
							notify(ctx, `Step "${parallelStep.name}" in parallel() does not support per-task --loop.`, "error");
							return false;
						}
						if (parallelStep.withContext === true) {
							notify(ctx, `Step "${parallelStep.name}" in parallel() does not support per-task --with-context.`, "error");
							return false;
						}
						const stepPrompt = prompts.get(parallelStep.name);
						if (!stepPrompt) continue;
						if (stepPrompt.chain) {
							notify(ctx, `Step "${parallelStep.name}" is a chain template. Chain nesting is not supported.`, "error");
							return false;
						}
						if (!shouldDelegatePrompt(stepPrompt, subagentOverride)) {
							notify(ctx, `Step "${parallelStep.name}" in parallel() must use delegated execution (subagent).`, "error");
							return false;
						}
					}
					continue;
				}

				const stepPrompt = prompts.get(step.name);
				if (!stepPrompt) continue;
				if (stepPrompt.chain) {
					notify(ctx, `Step "${step.name}" is a chain template. Chain nesting is not supported.`, "error");
					return false;
				}
			}

			return true;
		};

		if (!validateChainSteps()) return;

		const originalModel = getCurrentModel(ctx);
		const chainInheritedModel = originalModel;
		const originalThinking = pi.getThinkingLevel();
		let currentModel = originalModel;
		let currentThinking = originalThinking;
		chainActive = true;
		pendingSkillMessage = undefined;
		const effectiveMax = totalIterations ?? UNLIMITED_LOOP_CAP;
		const isUnlimited = totalIterations === null;
		const useConverge = converge;

		const anchorId = fresh ? ctx.sessionManager.getLeafId() : null;
		const chainStepNames = steps
			.map((step) => (isParallelChainStep(step) ? `parallel(${step.parallel.map((item) => item.name).join(", ")})` : step.name))
			.join(" -> ");
		let completedIterations = 0;
		let converged = false;
		let chainErrorState: ExecutionErrorState = { hasError: false, error: undefined };
		if (effectiveMax > 1) {
			loopState = { currentIteration: 1, totalIterations };
			accumulatedSummaries = [];
			updateLoopStatus(ctx);
		}

		try {
			for (let iteration = 0; iteration < effectiveMax; iteration++) {
				if (effectiveMax > 1) {
					loopState!.currentIteration = iteration + 1;
					updateLoopStatus(ctx);
					refreshPrompts(ctx.cwd, ctx);
					if (!validateChainSteps()) break;
				}

				const templates = steps.map((step) =>
					isParallelChainStep(step)
						? {
							kind: "parallel" as const,
							tasks: step.parallel.map((item) => ({
								name: item.name,
								args: item.args,
								prompt: {
									...prompts.get(item.name)!,
									...(cwdOverride ? { cwd: cwdOverride } : {}),
								},
							})),
						}
						: {
							kind: "single" as const,
							singleStep: {
								prompt: {
									...prompts.get(step.name)!,
									...(cwdOverride ? { cwd: cwdOverride } : {}),
								},
								stepArgs: step.args,
								stepLoop: step.loopCount !== undefined ? step.loopCount : 1,
								stepWithContext: step.withContext === true,
							},
						},
				);
				const chainStepSummaries: string[] = [];
				let aborted = false;
				let iterationChanged = false;
				let loopPrefix = "";
				if (effectiveMax > 1) {
					const label = totalIterations !== null ? `${iteration + 1}/${totalIterations}` : `${iteration + 1}`;
					loopPrefix = `Loop ${label}, `;
				}

				for (const [index, stepTemplate] of templates.entries()) {
					const stepNumber = index + 1;
					if (stepTemplate.kind === "parallel") {
						const stepNames = stepTemplate.tasks.map((task) => task.name).join(", ");
						const stepLabel = `parallel(${stepNames})`;
						notify(ctx, `${loopPrefix}Step ${stepNumber}/${templates.length}: parallel(${stepNames})`, "info");
						if (ctx.hasUI) {
							ctx.ui.setStatus("prompt-chain", ctx.ui.theme.fg("warning", `step ${stepNumber}/${templates.length}: parallel(${stepNames})`));
						}
						const stepStartId = ctx.sessionManager.getLeafId();
						let taskPreamble: string | undefined;
						const isForkedParallelContext = stepTemplate.tasks.some((task) => task.prompt.inheritContext === true);
						if (chainContextEnabled && !isForkedParallelContext && chainStepSummaries.length > 0) {
							taskPreamble = `[Previous chain steps]\n\n${chainStepSummaries.join("\n\n")}`;
						}

						let delegated;
						try {
							delegated = await executeSubagentPromptStep({
								pi,
								ctx,
								currentModel,
								override: subagentOverride,
								inheritedModel: chainInheritedModel,
								parallel: stepTemplate.tasks.map((task) => ({
									prompt: task.prompt,
									args: task.args.length > 0 ? task.args : sharedArgs,
								})),
								taskPreamble,
							});
						} catch (error) {
							notify(ctx, error instanceof Error ? error.message : String(error), "error");
							aborted = true;
							break;
						}
						if (!delegated) {
							notify(ctx, "Parallel chain step was not delegated.", "error");
							aborted = true;
							break;
						}

						currentModel = getCurrentModel(ctx);
						currentThinking = pi.getThinkingLevel();
						const stepEntries = getIterationEntries(ctx, stepStartId);
						if (didIterationMakeChanges(stepEntries)) iterationChanged = true;
						chainStepSummaries.push(generateChainStepSummary(stepEntries, stepLabel, stepNumber));
						continue;
					}

					const singleStep = stepTemplate.singleStep;
					const stepLoopTotal = singleStep.stepLoop;
					const stepLoopMax = stepLoopTotal ?? UNLIMITED_LOOP_CAP;
					const isStepLooping = stepLoopMax > 1;
					const effectiveArgs = singleStep.stepArgs.length > 0 ? singleStep.stepArgs : sharedArgs;
					const shouldInjectSummary =
						shouldDelegatePrompt(singleStep.prompt, subagentOverride) &&
						singleStep.prompt.inheritContext !== true &&
						(chainContextEnabled || singleStep.stepWithContext === true);
					const outerLoopState = loopState ? { ...loopState } : null;
					const stepStartId = ctx.sessionManager.getLeafId();
					if (isStepLooping) {
						loopState = { currentIteration: 1, totalIterations: stepLoopTotal };
						updateLoopStatus(ctx);
					}

					try {
						for (let stepIteration = 0; stepIteration < stepLoopMax; stepIteration++) {
							if (isStepLooping) {
								loopState = { currentIteration: stepIteration + 1, totalIterations: stepLoopTotal };
								updateLoopStatus(ctx);
							}

							const iterSuffix = isStepLooping
								? stepLoopTotal !== null
									? ` (iter ${stepIteration + 1}/${stepLoopTotal})`
									: ` (iter ${stepIteration + 1})`
								: "";
							notify(
								ctx,
								`${loopPrefix}Step ${stepNumber}/${templates.length}: ${singleStep.prompt.name}${iterSuffix} ${buildPromptCommandDescription(singleStep.prompt)}`,
								"info",
							);
							if (ctx.hasUI) {
								ctx.ui.setStatus("prompt-chain", ctx.ui.theme.fg("warning", `step ${stepNumber}/${templates.length}: ${singleStep.prompt.name}`));
							}
							const taskPreamble = shouldInjectSummary && chainStepSummaries.length > 0
								? `[Previous chain steps]\n\n${chainStepSummaries.join("\n\n")}`
								: undefined;

							const stepLoopContext = isStepLooping
								? `Step ${stepNumber}/${templates.length}: ${singleStep.prompt.name}${iterSuffix}`
								: undefined;
							const stepIterationStartId = ctx.sessionManager.getLeafId();
							const stepResult = await executePromptStep(
								singleStep.prompt,
								effectiveArgs,
								ctx,
								currentModel,
								subagentOverride,
								chainInheritedModel,
								taskPreamble,
								stepLoopContext,
							);
							if (stepResult === "aborted") {
								aborted = true;
								break;
							}

							currentModel = getCurrentModel(ctx);
							currentThinking = pi.getThinkingLevel();

							const stepIterationEntries = getIterationEntries(ctx, stepIterationStartId);
							const stepIterationChanged = didIterationMakeChanges(stepIterationEntries);
							if (isStepLooping && singleStep.prompt.converge !== false && !stepIterationChanged) {
								break;
							}
						}
					} finally {
						if (isStepLooping) {
							loopState = outerLoopState ? { ...outerLoopState } : null;
							updateLoopStatus(ctx);
						}
					}

					if (aborted) break;
					const stepEntries = getIterationEntries(ctx, stepStartId);
					if (didIterationMakeChanges(stepEntries)) iterationChanged = true;
					chainStepSummaries.push(generateChainStepSummary(stepEntries, singleStep.prompt.name, stepNumber));
				}

				if (aborted) break;
				completedIterations++;

				if (useConverge && (isUnlimited || effectiveMax > 1) && !iterationChanged) {
					converged = true;
					break;
				}

				if (anchorId && iteration < effectiveMax - 1) {
					freshCollapse = { targetId: anchorId, task: chainStepNames, iteration: iteration + 1, totalIterations };
					const result = await ctx.navigateTree(anchorId, { summarize: true });
					freshCollapse = null;
					if (result.cancelled) {
						notify(ctx, "Loop cancelled", "warning");
						break;
					}
				}
			}

		} catch (error) {
			chainErrorState = { hasError: true, error };
		} finally {
			chainErrorState = await restoreAfterExecution(
				ctx,
				shouldRestore,
				originalModel,
				originalThinking,
				getCurrentModel(ctx),
				pi.getThinkingLevel(),
				chainErrorState,
				"chain",
			);

			pendingSkillMessage = undefined;
			chainActive = false;
			loopState = null;
			freshCollapse = null;
			accumulatedSummaries = [];
			updateLoopStatus(ctx);
			if (ctx.hasUI) {
				ctx.ui.setStatus("prompt-chain", undefined);
			}

			if (!chainErrorState.hasError) {
				notifyLoopCompletion(ctx, completedIterations, totalIterations, effectiveMax, converged, true);
			}
		}

		if (chainErrorState.hasError) {
			throw chainErrorState.error;
		}
	}

	async function runPromptCommand(name: string, args: string, ctx: ExtensionCommandContext) {
		storedCommandCtx = ctx;
		refreshPrompts(ctx.cwd, ctx);
		const prompt = prompts.get(name);
		if (!prompt) {
			notify(ctx, `Prompt "${name}" no longer exists`, "error");
			return;
		}

		const subagent = extractSubagentOverride(args);
		const runtimeCwd = subagent.cwd ? expandCwdPath(subagent.cwd) : undefined;
		if (subagent.cwd && !runtimeCwd) {
			notify(ctx, `Invalid --cwd path: must be absolute`, "error");
			return;
		}
		const argsWithoutSubagent = subagent.args;

		if (prompt.chain) {
			if (subagent.model) notify(ctx, `--model is not supported on chain prompts (ignored)`, "warning");
			if (subagent.fork) notify(ctx, `--fork is not supported on chain prompts (ignored)`, "warning");
			const extracted = extractChainContextFlag(argsWithoutSubagent);
			const chainContextEnabled = extracted.chainContext || prompt.chainContext === "summary";
			const loop = extractLoopCount(extracted.args);
			let totalIterations: number | null = prompt.loop !== undefined ? prompt.loop : 1;
			let fresh = false;
			let converge = true;
			let cleanedArgs = extracted.args;

			if (loop) {
				totalIterations = loop.loopCount;
				fresh = loop.fresh;
				converge = loop.converge;
				cleanedArgs = loop.args;
			} else if (prompt.loop !== undefined) {
				const flags = extractLoopFlags(extracted.args);
				fresh = flags.fresh;
				converge = flags.converge;
				cleanedArgs = flags.args;
			}

			const { steps, invalidSegments } = parseChainDeclaration(prompt.chain);
			if (invalidSegments.length > 0) {
				notify(ctx, `Invalid chain step: ${invalidSegments[0]}`, "error");
				return;
			}
			if (steps.length === 0) {
				notify(ctx, "No templates specified", "error");
				return;
			}

			const cwdOverride = runtimeCwd ?? prompt.cwd;
			await runSharedChainExecution(
				steps,
				parseCommandArgs(cleanedArgs),
				totalIterations,
				fresh || prompt.fresh === true,
				converge && prompt.converge !== false,
				prompt.restore,
				ctx,
				subagent.override,
				cwdOverride,
				chainContextEnabled,
			);
			return;
		}

		const promptOverrides: Partial<Pick<PromptWithModel, "models" | "inheritContext">> = {
			...(subagent.model ? { models: [subagent.model] } : {}),
			...(subagent.fork ? { inheritContext: true } : {}),
		};

		const loop = extractLoopCount(argsWithoutSubagent);
		if (loop) {
			await runPromptLoop(name, loop.args, loop.loopCount, loop.fresh, loop.converge, ctx, subagent.override, runtimeCwd, promptOverrides);
			return;
		}

		if (prompt.loop !== undefined) {
			const flags = extractLoopFlags(argsWithoutSubagent);
			await runPromptLoop(name, flags.args, prompt.loop, flags.fresh, flags.converge, ctx, subagent.override, runtimeCwd, promptOverrides);
			return;
		}

		const effectivePrompt = { ...prompt, ...(runtimeCwd ? { cwd: runtimeCwd } : {}), ...promptOverrides };
		const savedModel = getCurrentModel(ctx);
		const savedThinking = pi.getThinkingLevel();
		const stepResult = await executePromptStep(
			effectivePrompt,
			parseCommandArgs(argsWithoutSubagent),
			ctx,
			savedModel,
			subagent.override,
		);
		if (stepResult === "aborted") return;

		if (!shouldDelegatePrompt(effectivePrompt, subagent.override) && prompt.restore) {
			const currentModel = getCurrentModel(ctx);
			if (savedModel && currentModel && !sameModel(savedModel, currentModel)) {
				previousModel = savedModel;
				previousThinking = savedThinking;
			}
			if (effectivePrompt.thinking && previousThinking === undefined && effectivePrompt.thinking !== savedThinking) {
				previousThinking = savedThinking;
			}
		}
	}

	function resetSessionScopedState(ctx: ExtensionContext) {
		storedCommandCtx = null;
		pendingSkillMessage = undefined;
		previousModel = undefined;
		previousThinking = undefined;
		runtimeModel = ctx.model;
		toolManager.clearQueue();
		refreshPrompts(ctx.cwd, ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		resetSessionScopedState(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		resetSessionScopedState(ctx);
	});

	pi.on("model_select", async (event) => {
		runtimeModel = event.model;
	});

	pi.on("before_agent_start", async (event) => {
		let systemPrompt = event.systemPrompt;

		if (toolManager.isEnabled() && !loopState && !chainActive) {
			const toolGuidance = toolManager.getGuidance();
			const guidance = toolGuidance
				? `The run-prompt tool is available for running prompt template commands. ${toolGuidance}`
				: "The run-prompt tool is available for running prompt template commands.";
			systemPrompt += `\n\n${guidance}`;
		}

		if (loopState) {
			const iterText =
				loopState.totalIterations !== null
					? `iteration ${loopState.currentIteration} of ${loopState.totalIterations}`
					: `iteration ${loopState.currentIteration}`;
			systemPrompt += `\n\nYou are on ${iterText} of the same prompt. Previous iterations and their results are visible in the conversation above. Build on that work — focus on what remains to improve.`;
		}

		const skillMessage = consumePendingSkillMessage();
		const hasSystemPromptOverride = systemPrompt !== event.systemPrompt;
		if (!hasSystemPromptOverride && !skillMessage) return;

		return {
			...(hasSystemPromptOverride ? { systemPrompt } : {}),
			...(skillMessage ? { message: skillMessage } : {}),
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (chainActive) return;
		if (loopState) return;

		runtimeModel = ctx.model;

		const restoreModel = previousModel;
		const restoreThinking = previousThinking;
		previousModel = undefined;
		previousThinking = undefined;

		const restoreFn = async () => {
			if (restoreModel || restoreThinking !== undefined) {
				await restoreSessionState(ctx, restoreModel, restoreThinking, getCurrentModel(ctx), pi.getThinkingLevel());
			}
		};
		const processed = await toolManager.processQueue(ctx, restoreFn);
		if (processed) return;
		await restoreFn();
	});

	pi.on("session_before_tree", async (event) => {
		if (!freshCollapse) return;
		if (event.preparation.targetId !== freshCollapse.targetId) return;

		const summary = generateIterationSummary(
			event.preparation.entriesToSummarize,
			freshCollapse.task,
			freshCollapse.iteration,
			freshCollapse.totalIterations,
		);
		accumulatedSummaries.push(summary);

		return {
			summary: {
				summary: accumulatedSummaries.join("\n\n---\n\n"),
			},
		};
	});

	async function runChainCommand(args: string, ctx: ExtensionCommandContext) {
		storedCommandCtx = ctx;
		refreshPrompts(ctx.cwd, ctx);

		const subagent = extractSubagentOverride(args);
		const runtimeCwd = subagent.cwd ? expandCwdPath(subagent.cwd) : undefined;
		if (subagent.cwd && !runtimeCwd) {
			notify(ctx, `Invalid --cwd path: must be absolute`, "error");
			return;
		}
		const extracted = extractChainContextFlag(subagent.args);
		const loop = extractLoopCount(extracted.args);
		const cleanedArgs = loop ? loop.args : extracted.args;

		const { steps, sharedArgs, invalidSegments } = parseChainSteps(cleanedArgs);
		if (invalidSegments.length > 0) {
			notify(ctx, `Invalid chain step: ${invalidSegments[0]}`, "error");
			return;
		}
		if (steps.length === 0) {
			notify(ctx, "No templates specified", "error");
			return;
		}

		await runSharedChainExecution(
			steps,
			sharedArgs,
			loop ? loop.loopCount : 1,
			loop?.fresh === true,
			loop?.converge ?? true,
			true,
			ctx,
			subagent.override,
			runtimeCwd,
			extracted.chainContext,
		);
	}

	refreshPrompts(process.cwd());
	if (toolManager.isEnabled()) toolManager.ensureRegistered();

	pi.registerCommand("chain-prompts", {
		description: "Chain prompt templates sequentially [template -> template -> ...]",
		handler: async (args, ctx) => {
			await runChainCommand(args, ctx);
		},
	});
	toolManager.registerCommand();
}
