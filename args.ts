export interface LoopExtraction {
	args: string;
	loopCount: number | null;
	fresh: boolean;
	converge: boolean;
}

export interface LoopFlags {
	args: string;
	fresh: boolean;
	converge: boolean;
}

export interface SubagentOverride {
	enabled: true;
	agent?: string;
}

export interface SubagentOverrideExtraction {
	args: string;
	override?: SubagentOverride;
	cwd?: string;
	model?: string;
	fork?: boolean;
}

export function extractLoopCount(argsString: string): LoopExtraction | null {
	let loopCount: number | null = null;
	let loopFound = false;
	let fresh = false;
	let noConverge = false;
	const tokensToRemove: Array<{ start: number; end: number }> = [];
	const loopTokenRanges: Array<{ start: number; end: number }> = [];

	let i = 0;
	while (i < argsString.length) {
		const char = argsString[i];

		if (char === '"' || char === "'") {
			const quote = char;
			i++;
			while (i < argsString.length && argsString[i] !== quote) i++;
			if (i < argsString.length) i++;
			continue;
		}

		if (/\s/.test(char)) {
			i++;
			continue;
		}

		const tokenStart = i;
		while (i < argsString.length && !/\s/.test(argsString[i])) i++;
		const token = argsString.slice(tokenStart, i);

		if (token.startsWith("--loop=")) {
			loopTokenRanges.push({ start: tokenStart, end: i });
			const value = token.slice("--loop=".length);
			if (/^\d+$/.test(value)) {
				const parsed = parseInt(value, 10);
				if (parsed >= 1 && parsed <= 999 && !loopFound) {
					loopFound = true;
					loopCount = parsed;
				}
			}
			continue;
		}

		if (token === "--loop") {
			let lookahead = i;
			while (lookahead < argsString.length && /\s/.test(argsString[lookahead])) lookahead++;

			if (lookahead < argsString.length && argsString[lookahead] !== '"' && argsString[lookahead] !== "'") {
				const nextTokenStart = lookahead;
				while (lookahead < argsString.length && !/\s/.test(argsString[lookahead])) lookahead++;
				const nextToken = argsString.slice(nextTokenStart, lookahead);

				if (/^\d+$/.test(nextToken)) {
					loopTokenRanges.push({ start: tokenStart, end: i }, { start: nextTokenStart, end: lookahead });
					const parsed = parseInt(nextToken, 10);
					if (parsed >= 1 && parsed <= 999 && !loopFound) {
						loopFound = true;
						loopCount = parsed;
					}
					i = lookahead;
					continue;
				}
			}

			loopTokenRanges.push({ start: tokenStart, end: i });
			if (!loopFound) {
				loopFound = true;
				loopCount = null;
			}
			continue;
		}

		if (token === "--fresh") {
			fresh = true;
			tokensToRemove.push({ start: tokenStart, end: i });
		}

		if (token === "--no-converge") {
			noConverge = true;
			tokensToRemove.push({ start: tokenStart, end: i });
		}
	}

	if (!loopFound) return null;

	const allRanges = [...tokensToRemove, ...loopTokenRanges];
	allRanges.sort((a, b) => b.start - a.start);
	let cleaned = argsString;
	for (const { start, end } of allRanges) {
		cleaned = cleaned.slice(0, start) + cleaned.slice(end);
	}

	const converge = !noConverge;
	return { args: cleaned.trim(), loopCount, fresh, converge };
}

export function extractLoopFlags(argsString: string): LoopFlags {
	let fresh = false;
	let noConverge = false;
	const tokensToRemove: Array<{ start: number; end: number }> = [];

	let i = 0;
	while (i < argsString.length) {
		const char = argsString[i];

		if (char === '"' || char === "'") {
			const quote = char;
			i++;
			while (i < argsString.length && argsString[i] !== quote) i++;
			if (i < argsString.length) i++;
			continue;
		}

		if (/\s/.test(char)) {
			i++;
			continue;
		}

		const tokenStart = i;
		while (i < argsString.length && !/\s/.test(argsString[i])) i++;
		const token = argsString.slice(tokenStart, i);

		if (token === "--fresh") {
			fresh = true;
			tokensToRemove.push({ start: tokenStart, end: i });
		}

		if (token === "--no-converge") {
			noConverge = true;
			tokensToRemove.push({ start: tokenStart, end: i });
		}
	}

	tokensToRemove.sort((a, b) => b.start - a.start);
	let cleaned = argsString;
	for (const { start, end } of tokensToRemove) {
		cleaned = cleaned.slice(0, start) + cleaned.slice(end);
	}

	return { args: cleaned.trim(), fresh, converge: !noConverge };
}

export function extractChainContextFlag(argsString: string): { args: string; chainContext: boolean } {
	let chainContext = false;
	const tokensToRemove: Array<{ start: number; end: number }> = [];

	let i = 0;
	while (i < argsString.length) {
		const char = argsString[i];

		if (char === '"' || char === "'") {
			const quote = char;
			i++;
			while (i < argsString.length && argsString[i] !== quote) i++;
			if (i < argsString.length) i++;
			continue;
		}

		if (/\s/.test(char)) {
			i++;
			continue;
		}

		const tokenStart = i;
		while (i < argsString.length && !/\s/.test(argsString[i])) i++;
		const token = argsString.slice(tokenStart, i);

		if (token === "--chain-context") {
			chainContext = true;
			tokensToRemove.push({ start: tokenStart, end: i });
		}
	}

	if (tokensToRemove.length === 0) {
		return { args: argsString.trim(), chainContext: false };
	}

	tokensToRemove.sort((a, b) => b.start - a.start);
	let cleaned = argsString;
	for (const { start, end } of tokensToRemove) {
		cleaned = cleaned.slice(0, start) + cleaned.slice(end);
	}

	return { args: cleaned.trim(), chainContext };
}

export function extractSubagentOverride(argsString: string): SubagentOverrideExtraction {
	let override: SubagentOverride | undefined;
	let cwdRaw: string | undefined;
	let modelRaw: string | undefined;
	let fork = false;
	const tokensToRemove: Array<{ start: number; end: number }> = [];

	let i = 0;
	while (i < argsString.length) {
		const char = argsString[i];

		if (char === '"' || char === "'") {
			const quote = char;
			i++;
			while (i < argsString.length && argsString[i] !== quote) i++;
			if (i < argsString.length) i++;
			continue;
		}

		if (/\s/.test(char)) {
			i++;
			continue;
		}

		const tokenStart = i;
		while (i < argsString.length && !/\s/.test(argsString[i])) i++;
		const token = argsString.slice(tokenStart, i);

		if (token === "--subagent") {
			tokensToRemove.push({ start: tokenStart, end: i });
			override = { enabled: true };
			continue;
		}

		if (token.startsWith("--subagent=") || token.startsWith("--subagent:")) {
			tokensToRemove.push({ start: tokenStart, end: i });
			const value = token.includes("=") ? token.slice("--subagent=".length) : token.slice("--subagent:".length);
			override = value ? { enabled: true, agent: value } : { enabled: true };
			continue;
		}

		if (token.startsWith("--cwd=")) {
			tokensToRemove.push({ start: tokenStart, end: i });
			const value = token.slice("--cwd=".length);
			cwdRaw = value || undefined;
			continue;
		}

		if (token.startsWith("--model=")) {
			tokensToRemove.push({ start: tokenStart, end: i });
			const value = token.slice("--model=".length);
			modelRaw = value || undefined;
			continue;
		}

		if (token === "--fork") {
			tokensToRemove.push({ start: tokenStart, end: i });
			fork = true;
			continue;
		}
	}

	if (tokensToRemove.length === 0) return { args: argsString.trim() };

	tokensToRemove.sort((a, b) => b.start - a.start);
	let cleaned = argsString;
	for (const { start, end } of tokensToRemove) {
		cleaned = cleaned.slice(0, start) + cleaned.slice(end);
	}

	if (fork && !override) override = { enabled: true };

	return {
		args: cleaned.trim(),
		...(override ? { override } : {}),
		...(cwdRaw !== undefined ? { cwd: cwdRaw } : {}),
		...(modelRaw !== undefined ? { model: modelRaw } : {}),
		...(fork ? { fork: true } : {}),
	};
}

export function splitByUnquotedSeparator(input: string, separator: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let inQuote: string | null = null;

	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		if (inQuote) {
			if (char === inQuote) inQuote = null;
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (i <= input.length - separator.length && input.startsWith(separator, i)) {
			parts.push(input.slice(start, i));
			start = i + separator.length;
			i += separator.length - 1;
		}
	}

	parts.push(input.slice(start));
	return parts;
}

export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];

		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (/\s/.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}

	if (current) {
		args.push(current);
	}

	return args;
}

export function substituteArgs(content: string, args: string[]): string {
	let result = content;

	result = result.replace(/\$(\d+)/g, (_, num) => {
		const index = parseInt(num, 10) - 1;
		return args[index] ?? "";
	});

	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
		let start = parseInt(startStr, 10) - 1;
		if (start < 0) start = 0;

		if (lengthStr) {
			const length = parseInt(lengthStr, 10);
			return args.slice(start, start + length).join(" ");
		}

		return args.slice(start).join(" ");
	});

	const allArgs = args.join(" ");
	result = result.replace(/\$ARGUMENTS/g, allArgs);
	result = result.replace(/\$@/g, allArgs);
	result = result.replace(/@\$/g, allArgs);

	return result;
}
