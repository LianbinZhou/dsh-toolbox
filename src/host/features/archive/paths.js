/**
 * Pure filesystem helpers behind the physical-delete path.
 *
 * Deliberately free of any DSH/cordis import so the delete route's safety
 * guarantees can be pinned by a plain Node test run: id normalisation, session
 * directory discovery, the sessions-root containment check, realpath-validated
 * removal, and the projection-cache scrub.
 *
 * @module dsh-toolbox/host/features/archive/paths (migrated verbatim from dsh-archive-manager, S4-b)
 */

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * Resolve the harness home directory: `$DSH_HOME` wins (relative values are
 * resolved against the process cwd, mirroring the official resolver), then
 * the platform home fallback `~/.dsh`.
 * @returns the absolute harness home path.
 */
function dshHome() {
	const raw = process.env.DSH_HOME;
	if (typeof raw === "string" && raw.trim() !== "") {
		const trimmed = raw.trim();
		return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
	}
	return join(homedir(), ".dsh");
}

/**
 * Absolute `<dshHome>/sessions` root — the one directory tree the delete path
 * is allowed to touch, and the containment boundary every removal checks.
 * @param home - absolute harness home.
 * @returns the absolute sessions root path.
 */
function sessionsRootFor(home) {
	return join(home, "sessions");
}

/**
 * Canonical session id. DSH keys a session's storage segment off the id: a
 * `session-<uuid>` id may land as segment `<uuid>`, and the archive set mixes
 * both spellings, so every comparison goes through this normal form.
 * @param id - raw session id in either spelling.
 * @returns the `session-`-prefixed form.
 */
function canonicalSessionId(id) {
	if (typeof id !== "string" || id.length === 0) return "";
	return id.startsWith("session-") ? id : `session-${id}`;
}

/**
 * The one id shape this module accepts (R3: allowlist, not denylist).
 *
 * A DSH session segment is a uuid, optionally `session-` prefixed. Anything
 * else — a Windows device name, an internal space, a percent-encoded traversal,
 * a unicode bidi control — is rejected here rather than reasoned about later.
 */
const SAFE_SESSION_ID = /^(?:session-)?[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;

/**
 * Reject anything that is not a plausible session segment.
 *
 * S4-b hardening: an ALLOWLIST (uuid hex and dashes, optional `session-`
 * prefix). The earlier denylist let through Windows device names (`CON`,
 * `NUL`), internal spaces, `%2e%2e` and unicode separators; none of those can
 * now reach the filesystem walk.
 * @param id - candidate session id from the request body.
 */
function isSafeSessionId(id) {
	return typeof id === "string" && SAFE_SESSION_ID.test(id);
}

/**
 * A cache key that is safe to join onto the projection-cache directory, or null.
 *
 * Same allowlist as {@link isSafeSessionId}: `scrubProjcache` turns ids into file
 * names, and without this a malformed id such as `../../outside/marker` unlinks a
 * file OUTSIDE the harness home. An exported best-effort helper must not depend
 * on its caller for that.
 * @param id - candidate session id.
 * @returns the id, or null when it may not be used as a file name.
 */
function safeCacheKey(id) {
	return isSafeSessionId(id) ? id : null;
}

/** True when `child` is `root` itself or lies underneath it (lexical). */
function isInside(root, child) {
	const rootAbs = resolve(root);
	const childAbs = resolve(child);
	if (childAbs === rootAbs) return true;
	return childAbs.startsWith(rootAbs + sep);
}

/**
 * Locate one session's storage directory: `<sessionsRoot>/<project>/<segment>`
 * where the project dir is the cwd-encoded key and the segment is the session
 * id (bare uuid or prefixed). A candidate whose realpath escapes the sessions
 * root is never returned, so symlinks cannot redirect a delete.
 * @param sessionsRoot - absolute `<dshHome>/sessions`.
 * @param sessionId - canonical or bare session id.
 * @returns the absolute session directory path, or undefined when absent.
 */
function findSessionDir(sessionsRoot, sessionId) {
	const wanted = new Set([sessionId, sessionId.replace(/^session-/, "")]);
	let rootReal;
	try {
		rootReal = realpathSync(sessionsRoot);
	} catch {
		return void 0;
	}
	let projects;
	try {
		projects = readdirSync(sessionsRoot);
	} catch {
		return void 0;
	}
	for (const project of projects) {
		const projectPath = join(sessionsRoot, project);
		let segments;
		try {
			segments = readdirSync(projectPath);
		} catch {
			continue;
		}
		for (const segment of segments) {
			if (!wanted.has(segment)) continue;
			const dirPath = join(projectPath, segment);
			try {
				// R2: a link is never a session, even when it resolves inside the
				// root — returning it would let a removal delete its target.
				if (lstatSync(dirPath).isSymbolicLink()) continue;
				if (!statSync(dirPath).isDirectory()) continue;
				if (!isInside(rootReal, realpathSync(dirPath))) continue;
			} catch {
				continue;
			}
			return dirPath;
		}
	}
	return void 0;
}

/**
 * Physically remove one session directory. The path is re-validated by
 * realpath against the sessions root immediately before the recursive
 * removal, so no caller-supplied path can reach anything outside session
 * storage. `force: false` keeps a surprise (a vanished tree) loud instead of
 * silently reporting success.
 * @param dirPath - directory resolved by {@link findSessionDir}.
 * @param sessionsRoot - absolute `<dshHome>/sessions`.
 */
function removeSessionDir(dirPath, sessionsRoot) {
	const rootReal = realpathSync(sessionsRoot);

	// R2: inspect the path itself first. `realpathSync` would resolve a link and
	// we would then be checking (and removing) its TARGET.
	const stat = lstatSync(dirPath);
	if (stat.isSymbolicLink()) {
		throw new Error("refusing to remove a link");
	}
	if (!stat.isDirectory()) {
		throw new Error("refusing to remove something that is not a directory");
	}

	const real = realpathSync(dirPath);
	if (real === rootReal) {
		throw new Error("refusing to remove the sessions root itself");
	}
	if (!isInside(rootReal, real)) {
		throw new Error("refusing to remove a path outside the sessions root");
	}
	// R1: exactly <root>/<project>/<segment>. A shallower target would take other
	// sessions with it; a deeper one is not a session directory at all.
	if (dirname(dirname(real)) !== rootReal) {
		throw new Error("refusing to remove a path that is not a two-level session directory");
	}
	rmSync(real, { recursive: true, force: false });
}

/**
 * Best-effort projection-cache scrub: the aggregate index
 * (`<dshHome>/storages/session_projcache.json`) plus the per-session file
 * (`<dshHome>/storages/session_projcache/sessions/<id>.json`). Both spellings
 * of the id are handled. A stale entry here is cosmetic, so every failure is
 * swallowed — the harness owns these files and will reconcile anyway.
 * @param home - absolute harness home.
 * @param ids - session ids whose cache rows are dropped.
 */
function scrubProjcache(home, ids) {
	// A mutating helper must not trust its caller: an id that cannot be a file
	// name contributes no keys, so it can never reach a path outside the cache.
	const keysBy = (id) => {
		const safe = safeCacheKey(id);
		if (safe === null) return [];
		return [safe, safe.replace(/^session-/, "")];
	};
	const indexPath = join(home, "storages", "session_projcache.json");
	try {
		if (existsSync(indexPath)) {
			const parsed = JSON.parse(readFileSync(indexPath, "utf8"));
			const sessions = parsed?.tables?.sessions;
			if (sessions !== void 0 && sessions !== null) {
				let touched = false;
				for (const id of ids) {
					for (const key of keysBy(id)) {
						if (Object.prototype.hasOwnProperty.call(sessions, key)) {
							delete sessions[key];
							touched = true;
						}
					}
				}
				if (touched) writeFileSync(indexPath, JSON.stringify(parsed, null, 2), "utf8");
			}
		}
	} catch {
		// A corrupt index is left alone; the harness owns it.
	}
	const perSessionDir = join(home, "storages", "session_projcache", "sessions");
	for (const id of ids) {
		for (const key of keysBy(id)) {
			const file = join(perSessionDir, `${key}.json`);
			try {
				if (existsSync(file)) unlinkSync(file);
			} catch {
				// Same best-effort contract.
			}
		}
	}
}

export { canonicalSessionId, dshHome, findSessionDir, isInside, isSafeSessionId, removeSessionDir, scrubProjcache, sessionsRootFor };

