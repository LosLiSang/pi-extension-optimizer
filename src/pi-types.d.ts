/**
 * Minimal ExtensionAPI type stub.
 *
 * This package has zero runtime harness imports (`import type` is erased by esbuild; pi's loader injects the
 * host API at startup), so @earendil-works/pi-coding-agent is deliberately not listed in
 * dependencies/peerDependencies — otherwise npm's automatic peer install would pull the whole harness and its
 * transitive deps (e.g. minimatch -> brace-expansion <5.0.8, GHSA-mh99-v99m-4gvg) into the install tree and make
 * `pi install git:...` report a high severity vulnerability.
 *
 * The type surface follows pi 0.83's dist/core/extensions/types.d.ts; only what this package uses is declared.
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
