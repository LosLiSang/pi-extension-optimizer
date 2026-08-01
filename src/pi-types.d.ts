/**
 * 最小 ExtensionAPI 类型桩。
 *
 * 本包运行时零 harness import（`import type` 会被 esbuild 擦除，真正启动时由
 * pi 的 loader 注入宿主 API），因此不把 @earendil-works/pi-coding-agent 放进
 * dependencies/peerDependencies —— 否则 npm 自动安装 peer 依赖会把整个 harness
 * 及其传递依赖（如 minimatch -> brace-expansion <5.0.8，GHSA-mh99-v99m-4gvg）
 * 拉进安装树，导致 `pi install git:...` 报 high severity vulnerability。
 *
 * 类型面以 pi 0.83 的 dist/core/extensions/types.d.ts 为准，这里只声明本包用到的部分。
 */
declare module "@earendil-works/pi-coding-agent" {
	export interface AutocompleteItem {
		value: string;
		label?: string;
	}

	export interface ExtensionCommandContext {
		hasUI: boolean;
		ui: {
			select(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
			confirm(title: string, message: string, opts?: unknown): Promise<boolean>;
			notify(message: string, type?: "info" | "warning" | "error"): void;
			setStatus(key: string, text: string | undefined): void;
		};
		reload(): Promise<void>;
	}

	export interface ExtensionAPI {
		registerCommand(
			name: string,
			options: {
				description?: string;
				getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
			},
		): void;
	}
}
