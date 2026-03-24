import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { parseChainDeclaration } from "./chain-parser.js";

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const RESERVED_COMMAND_NAMES = new Set([
	"chain-prompts",
	"prompt-tool",
	"settings",
	"model",
	"scoped-models",
	"export",
	"share",
	"copy",
	"name",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"tree",
	"login",
	"logout",
	"new",
	"compact",
	"resume",
	"reload",
	"quit",
]);

export type PromptSource = "user" | "project";

export interface PromptWithModel {
	name: string;
	description: string;
	content: string;
	models: string[];
	chain?: string;
	chainContext?: "summary";
	restore: boolean;
	skill?: string;
	thinking?: ThinkingLevel;
	thinkingLevels?: ThinkingLevel[];
	rotate?: boolean;
	fresh?: boolean;
	loop?: number | null;
	converge?: boolean;
	subagent?: true | string;
	inheritContext?: boolean;
	cwd?: string;
	source: PromptSource;
	subdir?: string;
	filePath: string;
}

export interface PromptLoaderDiagnostic {
	code: string;
	message: string;
	filePath: string;
	source: PromptSource;
	key: string;
}

export interface LoadPromptsWithModelResult {
	prompts: Map<string, PromptWithModel>;
	diagnostics: PromptLoaderDiagnostic[];
}

function createDiagnostic(
	code: string,
	filePath: string,
	source: PromptSource,
	message: string,
): PromptLoaderDiagnostic {
	return {
		code,
		message,
		filePath,
		source,
		key: `${code}:${filePath}:${message}`,
	};
}

function lexicalCompare(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function normalizeStringField(
	field: string,
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		diagnostics.push(
			createDiagnostic(
				`invalid-${field}`,
				filePath,
				source,
				`Ignoring invalid ${field} value in ${filePath}: expected a string.`,
			),
		);
		return undefined;
	}

	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function isValidModelSelectionSpec(spec: string): boolean {
	if (!spec || spec.includes("*") || /\s/.test(spec)) return false;

	const segments = spec.split("/");
	if (segments.length === 1) return true;
	if (segments.length !== 2) return false;
	return segments[0].length > 0 && segments[1].length > 0;
}

function normalizeFrontmatterRecord(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): Record<string, unknown> | undefined {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-frontmatter",
			filePath,
			source,
			`Skipping prompt template at ${filePath}: frontmatter must be a key-value object.`,
		),
	);
	return undefined;
}

function normalizeModelSpecs(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): string[] | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		diagnostics.push(
			createDiagnostic(
				"invalid-model",
				filePath,
				source,
				`Skipping prompt template at ${filePath}: frontmatter field "model" must be a string.`,
			),
		);
		return undefined;
	}

	const models = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

	if (models.length === 0) {
		diagnostics.push(
			createDiagnostic(
				"empty-model",
				filePath,
				source,
				`Skipping prompt template at ${filePath}: frontmatter field "model" is empty.`,
			),
		);
		return undefined;
	}

	const invalidSpec = models.find((model) => !isValidModelSelectionSpec(model));
	if (invalidSpec) {
		diagnostics.push(
			createDiagnostic(
				"invalid-model-spec",
				filePath,
				source,
				`Skipping prompt template at ${filePath}: invalid model spec ${JSON.stringify(invalidSpec)} in frontmatter field "model".`,
			),
		);
		return undefined;
	}

	return models;
}

function normalizeRestore(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return true;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-restore",
			filePath,
			source,
			`Using default restore=true for ${filePath}: frontmatter field "restore" must be true or false.`,
		),
	);
	return true;
}

function normalizeFresh(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-fresh",
			filePath,
			source,
			`Using default fresh=false for ${filePath}: frontmatter field "fresh" must be true or false.`,
		),
	);
	return false;
}

function normalizeRotate(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-rotate",
			filePath,
			source,
			`Using default rotate=false for ${filePath}: frontmatter field "rotate" must be true or false.`,
		),
	);
	return false;
}

function normalizeLoop(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): number | null | undefined {
	if (value === undefined) return undefined;

	if (value === true || (typeof value === "string" && value.trim().toLowerCase() === "unlimited")) {
		return null;
	}

	let normalizedValue: number | undefined;
	if (typeof value === "number") {
		normalizedValue = value;
	} else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		normalizedValue = parseInt(value.trim(), 10);
	}

	if (normalizedValue !== undefined && Number.isInteger(normalizedValue) && normalizedValue >= 1 && normalizedValue <= 999) {
		return normalizedValue;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-loop",
			filePath,
			source,
			`Ignoring invalid loop value in ${filePath}: frontmatter field "loop" must be an integer between 1 and 999, true, or "unlimited".`,
		),
	);
	return undefined;
}

function normalizeConverge(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return true;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-converge",
			filePath,
			source,
			`Using default converge=true for ${filePath}: frontmatter field "converge" must be true or false.`,
		),
	);
	return true;
}

function normalizeSubagent(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): true | string | undefined {
	if (value === undefined) return undefined;
	if (value === true) return true;
	if (value === false) return undefined;
	if (typeof value !== "string") {
		diagnostics.push(
			createDiagnostic(
				"invalid-subagent",
				filePath,
				source,
				`Ignoring invalid subagent value in ${filePath}: frontmatter field "subagent" must be true or a non-empty string.`,
			),
		);
		return undefined;
	}

	const normalized = value.trim();
	if (!normalized) {
		diagnostics.push(
			createDiagnostic(
				"invalid-subagent",
				filePath,
				source,
				`Ignoring invalid subagent value in ${filePath}: frontmatter field "subagent" must be true or a non-empty string.`,
			),
		);
		return undefined;
	}
	return normalized;
}

export function expandCwdPath(raw: string): string | undefined {
	const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
	return isAbsolute(expanded) ? expanded : undefined;
}

function normalizeCwd(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		diagnostics.push(
			createDiagnostic(
				"invalid-cwd",
				filePath,
				source,
				`Ignoring invalid cwd in ${filePath}: expected a string.`,
			),
		);
		return undefined;
	}

	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const expanded = expandCwdPath(trimmed);
	if (!expanded) {
		diagnostics.push(
			createDiagnostic(
				"invalid-cwd",
				filePath,
				source,
				`Ignoring cwd in ${filePath}: must be an absolute path.`,
			),
		);
		return undefined;
	}
	return expanded;
}

function normalizeInheritContext(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-inherit-context",
			filePath,
			source,
			`Using default inheritContext=false for ${filePath}: frontmatter field "inheritContext" must be true or false.`,
		),
	);
	return false;
}

function normalizeChain(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		diagnostics.push(
			createDiagnostic(
				"invalid-chain",
				filePath,
				source,
				`Ignoring invalid chain value in ${filePath}: frontmatter field "chain" must be a string.`,
			),
		);
		return undefined;
	}

	const normalized = value.trim();
	if (normalized.length > 0) return normalized;

	diagnostics.push(
		createDiagnostic(
			"empty-chain",
			filePath,
			source,
			`Ignoring invalid chain value in ${filePath}: frontmatter field "chain" must be a non-empty string.`,
		),
	);
	return undefined;
}

function normalizeChainContext(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): "summary" | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "summary") return "summary";
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-chain-context",
			filePath,
			source,
			`Ignoring invalid chainContext value in ${filePath}: frontmatter field "chainContext" must be "summary".`,
		),
	);
	return undefined;
}

function normalizeThinking(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): ThinkingLevel | undefined {
	const thinking = normalizeStringField("thinking", value, filePath, source, diagnostics);
	if (thinking === undefined) return undefined;

	const normalized = thinking.toLowerCase();
	if ((VALID_THINKING_LEVELS as readonly string[]).includes(normalized)) {
		return normalized as ThinkingLevel;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-thinking",
			filePath,
			source,
			`Ignoring invalid thinking level in ${filePath}: ${JSON.stringify(thinking)}.`,
		),
	);
	return undefined;
}

function normalizeThinkingLevels(
	value: unknown,
	modelCount: number,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): ThinkingLevel[] | undefined {
	if (typeof value !== "string") return undefined;

	const levels = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

	const invalidLevel = levels.find((level) => !(VALID_THINKING_LEVELS as readonly string[]).includes(level.toLowerCase()));
	if (invalidLevel) {
		diagnostics.push(
			createDiagnostic(
				"invalid-thinking-levels",
				filePath,
				source,
				`Ignoring invalid thinking level in ${filePath}: ${JSON.stringify(invalidLevel)}.`,
			),
		);
		return undefined;
	}

	if (levels.length !== modelCount) {
		diagnostics.push(
			createDiagnostic(
				"invalid-thinking-level-count",
				filePath,
				source,
				`Ignoring comma-separated thinking levels in ${filePath}: expected ${modelCount} entries to match frontmatter field "model".`,
			),
		);
		return undefined;
	}

	return levels.map((level) => level.toLowerCase() as ThinkingLevel);
}

function loadPromptsWithModelFromDir(
	dir: string,
	source: PromptSource,
	subdir = "",
	visitedDirectories = new Set<string>(),
): { prompts: PromptWithModel[]; diagnostics: PromptLoaderDiagnostic[] } {
	const prompts: PromptWithModel[] = [];
	const diagnostics: PromptLoaderDiagnostic[] = [];

	if (!existsSync(dir)) {
		return { prompts, diagnostics };
	}

	let canonicalDir: string;
	try {
		canonicalDir = realpathSync(dir);
	} catch (error) {
		diagnostics.push(
			createDiagnostic(
				"unreadable-directory",
				dir,
				source,
				`Skipping prompt directory ${dir}: ${error instanceof Error ? error.message : String(error)}.`,
			),
		);
		return { prompts, diagnostics };
	}

	if (visitedDirectories.has(canonicalDir)) {
		diagnostics.push(
			createDiagnostic(
				"directory-cycle",
				dir,
				source,
				`Skipping already visited prompt directory at ${dir}.`,
			),
		);
		return { prompts, diagnostics };
	}

	visitedDirectories.add(canonicalDir);

	try {
		const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => lexicalCompare(a.name, b.name));

		for (const entry of entries) {
			const fullPath = join(dir, entry.name);

			let isFile = entry.isFile();
			let isDirectory = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isFile = stats.isFile();
					isDirectory = stats.isDirectory();
				} catch (error) {
					diagnostics.push(
						createDiagnostic(
							"unreadable-symlink",
							fullPath,
							source,
							`Skipping unreadable symlink at ${fullPath}: ${error instanceof Error ? error.message : String(error)}.`,
						),
					);
					continue;
				}
			}

			if (isDirectory) {
				const nextSubdir = subdir ? `${subdir}:${entry.name}` : entry.name;
				const nested = loadPromptsWithModelFromDir(fullPath, source, nextSubdir, visitedDirectories);
				prompts.push(...nested.prompts);
				diagnostics.push(...nested.diagnostics);
				continue;
			}

			if (!isFile || !entry.name.endsWith(".md")) continue;

			try {
				const rawContent = readFileSync(fullPath, "utf-8");
				const parsed = parseFrontmatter<Record<string, unknown>>(rawContent);
				const frontmatter = normalizeFrontmatterRecord(parsed.frontmatter, fullPath, source, diagnostics);
				if (!frontmatter) continue;
				const { body } = parsed;
				const chain = normalizeChain(frontmatter.chain, fullPath, source, diagnostics);
				const chainContext = chain ? normalizeChainContext(frontmatter.chainContext, fullPath, source, diagnostics) : undefined;
				if (chain && /\bparallel\s*\(/.test(chain)) {
					const parsedChain = parseChainDeclaration(chain);
					if (parsedChain.invalidSegments.length > 0 || parsedChain.steps.length === 0) {
						diagnostics.push(
							createDiagnostic(
								"invalid-chain-declaration",
								fullPath,
								source,
								`Skipping prompt template at ${fullPath}: invalid chain declaration segment ${JSON.stringify(parsedChain.invalidSegments[0] ?? chain)}.`,
							),
						);
						continue;
					}
				}
				let subagent = normalizeSubagent(frontmatter.subagent, fullPath, source, diagnostics);
				const cwd = normalizeCwd(frontmatter.cwd, fullPath, source, diagnostics);
				const inheritContext = normalizeInheritContext(frontmatter.inheritContext, fullPath, source, diagnostics);
				if (chain && subagent !== undefined) {
					diagnostics.push(
						createDiagnostic(
							"invalid-subagent-chain",
							fullPath,
							source,
							`Ignoring subagent in ${fullPath}: frontmatter fields "chain" and "subagent" cannot be combined.`,
						),
					);
					subagent = undefined;
				}
				if (subagent === undefined && inheritContext) {
					diagnostics.push(
						createDiagnostic(
							"invalid-inherit-context",
							fullPath,
							source,
							`Ignoring inheritContext in ${fullPath}: frontmatter field "inheritContext" requires "subagent".`,
						),
					);
				}
				if (!chain && subagent === undefined && cwd) {
					diagnostics.push(
						createDiagnostic(
							"invalid-cwd",
							fullPath,
							source,
							`Ignoring cwd in ${fullPath}: frontmatter field "cwd" requires "subagent".`,
						),
					);
				}
				const hasModelField = Object.hasOwn(frontmatter, "model");
				const parsedModels = chain ? [] : normalizeModelSpecs(frontmatter.model, fullPath, source, diagnostics);
				if (!chain && hasModelField && !parsedModels) continue;
				const models = chain ? [] : (parsedModels ?? []);
				const rotate = chain ? false : normalizeRotate(frontmatter.rotate, fullPath, source, diagnostics);

				const name = entry.name.slice(0, -3);
				if (RESERVED_COMMAND_NAMES.has(name)) {
					diagnostics.push(
						createDiagnostic(
							"reserved-command-name",
							fullPath,
							source,
							`Skipping prompt template at ${fullPath}: command name "${name}" is reserved.`,
						),
					);
					continue;
				}

				const safeInheritContext = subagent !== undefined && inheritContext;
				const safeCwd = (chain || subagent !== undefined) ? cwd : undefined;
				const description = normalizeStringField("description", frontmatter.description, fullPath, source, diagnostics) ?? "";
				const skill = chain ? undefined : normalizeStringField("skill", frontmatter.skill, fullPath, source, diagnostics);
				let thinking: ThinkingLevel | undefined;
				let thinkingLevels: ThinkingLevel[] | undefined;
				if (!chain) {
					if (rotate && typeof frontmatter.thinking === "string" && frontmatter.thinking.includes(",")) {
						thinkingLevels = normalizeThinkingLevels(frontmatter.thinking, models.length, fullPath, source, diagnostics);
					} else {
						thinking = normalizeThinking(frontmatter.thinking, fullPath, source, diagnostics);
					}
				}
				const restore = normalizeRestore(frontmatter.restore, fullPath, source, diagnostics);
				const fresh = normalizeFresh(frontmatter.fresh, fullPath, source, diagnostics);
				const loop = normalizeLoop(frontmatter.loop, fullPath, source, diagnostics);
				const converge = normalizeConverge(frontmatter.converge, fullPath, source, diagnostics);
				const hasModelConditionalDirectives = /<if-model(?:\s|>)|<else(?:\s|>)|<\/if-model\s*>|<\/else(?:\s|>)/.test(body);
				const hasExtensionSpecificConfig =
					skill !== undefined ||
					thinking !== undefined ||
					fresh === true ||
					loop !== undefined ||
					converge === false ||
					subagent !== undefined ||
					safeInheritContext ||
					hasModelConditionalDirectives;
				if (!chain && !hasModelField && !hasExtensionSpecificConfig) {
					continue;
				}

				prompts.push({
					name,
					description,
					content: body,
					models,
					chain: chain || undefined,
					chainContext,
					restore,
					skill,
					thinking,
					thinkingLevels,
					rotate: rotate || undefined,
					fresh: fresh || undefined,
					loop: loop !== undefined ? loop : undefined,
					converge: converge === false ? false : undefined,
					subagent,
					inheritContext: safeInheritContext || undefined,
					cwd: safeCwd || undefined,
					source,
					subdir: subdir || undefined,
					filePath: fullPath,
				});
			} catch (error) {
				diagnostics.push(
					createDiagnostic(
						"invalid-prompt-file",
						fullPath,
						source,
						`Skipping prompt template at ${fullPath}: ${error instanceof Error ? error.message : String(error)}.`,
					),
				);
			}
		}
	} catch (error) {
		diagnostics.push(
			createDiagnostic(
				"unreadable-directory",
				dir,
				source,
				`Skipping prompt directory ${dir}: ${error instanceof Error ? error.message : String(error)}.`,
			),
		);
	}

	return { prompts, diagnostics };
}

export function loadPromptsWithModel(cwd: string): LoadPromptsWithModelResult {
	const globalDir = join(homedir(), ".pi", "agent", "prompts");
	const projectDir = resolve(cwd, ".pi", "prompts");
	const promptMap = new Map<string, PromptWithModel>();
	const diagnostics: PromptLoaderDiagnostic[] = [];

	function addPrompt(prompt: PromptWithModel) {
		const existing = promptMap.get(prompt.name);
		if (!existing) {
			promptMap.set(prompt.name, prompt);
			return;
		}

		if (existing.source === prompt.source) {
			diagnostics.push(
				createDiagnostic(
					"duplicate-command-name",
					prompt.filePath,
					prompt.source,
					`Skipping ${prompt.source} prompt template "${prompt.name}" at ${prompt.filePath} because it conflicts with ${existing.filePath}.`,
				),
			);
			return;
		}

		promptMap.set(prompt.name, prompt);
	}

	const globalResult = loadPromptsWithModelFromDir(globalDir, "user");
	diagnostics.push(...globalResult.diagnostics);
	for (const prompt of globalResult.prompts) {
		addPrompt(prompt);
	}

	const projectResult = loadPromptsWithModelFromDir(projectDir, "project");
	diagnostics.push(...projectResult.diagnostics);
	for (const prompt of projectResult.prompts) {
		addPrompt(prompt);
	}

	return { prompts: promptMap, diagnostics };
}

export function buildPromptCommandDescription(prompt: PromptWithModel): string {
	const sourceLabel = prompt.subdir ? `(${prompt.source}:${prompt.subdir})` : `(${prompt.source})`;
	if (prompt.chain) {
		const chainContextLabel = prompt.chainContext ? ` ${prompt.chainContext}` : "";
		const cwdLabel = prompt.cwd ? ` cwd:${prompt.cwd}` : "";
		const details = `[chain: ${prompt.chain}${chainContextLabel}${cwdLabel}] ${sourceLabel}`;
		return prompt.description ? `${prompt.description} ${details}` : details;
	}
	const modelLabel = prompt.models.length > 0 ? prompt.models.map((model) => model.split("/").pop() || model).join("|") : "current";
	const rotateLabel = prompt.rotate ? " rotate" : "";
	const skillLabel = prompt.skill ? ` +${prompt.skill}` : "";
	const thinkingValue = prompt.thinkingLevels ? prompt.thinkingLevels.join(",") : prompt.thinking;
	const thinkingLabel = thinkingValue ? ` ${thinkingValue}` : "";
	const loopLabel = prompt.loop !== undefined ? ` loop:${prompt.loop === null ? "unlimited" : prompt.loop}` : "";
	const subagentLabel = prompt.subagent ? ` subagent:${prompt.subagent === true ? "delegate" : prompt.subagent}` : "";
	const cwdLabel = prompt.cwd ? ` cwd:${prompt.cwd}` : "";
	const inheritContextLabel = prompt.inheritContext ? " fork" : "";
	const details = `[${modelLabel}${rotateLabel}${thinkingLabel}${skillLabel}${loopLabel}${subagentLabel}${cwdLabel}${inheritContextLabel}] ${sourceLabel}`;
	return prompt.description ? `${prompt.description} ${details}` : details;
}

function getSkillCandidates(baseDir: string, skillName: string): string[] {
	return [join(baseDir, skillName, "SKILL.md"), join(baseDir, `${skillName}.md`)];
}

function* walkAncestors(startDir: string, stopDir?: string): Generator<string> {
	let current = startDir;
	while (true) {
		yield current;
		if (stopDir && current === stopDir) return;
		const parent = dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

function findRepoRoot(startDir: string): string | undefined {
	for (const dir of walkAncestors(startDir)) {
		if (existsSync(join(dir, ".git"))) return dir;
	}
	return undefined;
}

function findFirstExisting(paths: string[]): string | undefined {
	for (const path of paths) {
		if (existsSync(path)) return path;
	}
	return undefined;
}

export function resolveSkillPath(skillName: string, cwd: string): string | undefined {
	const projectDir = resolve(cwd);

	const projectPiSkill = findFirstExisting(getSkillCandidates(resolve(projectDir, ".pi", "skills"), skillName));
	if (projectPiSkill) return projectPiSkill;

	const repoRoot = findRepoRoot(projectDir);
	for (const dir of walkAncestors(projectDir, repoRoot)) {
		const projectAgentsSkill = findFirstExisting(getSkillCandidates(join(dir, ".agents", "skills"), skillName));
		if (projectAgentsSkill) return projectAgentsSkill;
	}

	const globalPiSkill = findFirstExisting(getSkillCandidates(join(homedir(), ".pi", "agent", "skills"), skillName));
	if (globalPiSkill) return globalPiSkill;

	return findFirstExisting(getSkillCandidates(join(homedir(), ".agents", "skills"), skillName));
}

export function readSkillContent(skillPath: string): string {
	const raw = readFileSync(skillPath, "utf-8");
	return parseFrontmatter(raw).body;
}
