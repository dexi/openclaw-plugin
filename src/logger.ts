/** Thin wrapper over OpenClaw's PluginLogger with a debug gate and a
 * console fallback for CLI-only code paths. */

export type LoggerLike = {
	debug?: (message: string) => void
	info: (message: string) => void
	warn: (message: string) => void
	error: (message: string) => void
}

let sink: LoggerLike | undefined
let debugEnabled = false

export function initLogger(logger: LoggerLike | undefined, debug: boolean): void {
	sink = logger
	debugEnabled = debug
}

function fmt(message: string, err?: unknown): string {
	if (err === undefined) return `dexi: ${message}`
	const detail = err instanceof Error ? err.message : String(err)
	return `dexi: ${message}: ${detail}`
}

export const log = {
	debug(message: string): void {
		if (!debugEnabled) return
		// Debug is opt-in (config `debug: true`); surface it at info level so it
		// shows regardless of the host's log-level filtering.
		sink?.info(fmt(`[debug] ${message}`))
	},
	info(message: string): void {
		sink?.info(fmt(message))
	},
	warn(message: string, err?: unknown): void {
		sink?.warn(fmt(message, err))
	},
	error(message: string, err?: unknown): void {
		sink?.error(fmt(message, err))
	},
}
