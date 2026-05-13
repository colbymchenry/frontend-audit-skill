#!/usr/bin/env node
/**
 * Walk the design directory, hash each goal PNG, and report whether
 * its sibling regions file is in sync with the current image content.
 *
 * Three states per PNG:
 *
 *   new          — no sibling regions file exists at all
 *   stale        — sibling regions file exists, but its _meta.sourceHash
 *                  doesn't match the current PNG's SHA-256
 *   up-to-date   — sibling regions file exists with matching hash
 *   unhashed     — sibling regions file exists but has no _meta block
 *                  (legacy / authored before this convention). Treated
 *                  as up-to-date but flagged so you can re-stamp if you
 *                  want hash enforcement
 *
 * Usage:
 *   bun ~/.claude/skills/frontend-audit/scripts/discover.mjs \
 *       [<design-dir>] [--stamp]
 *
 * Defaults:
 *   <design-dir>: ./design (or designDir from .frontend-audit.json)
 *   --stamp:     for any regions file that's `up-to-date` or `unhashed`,
 *                rewrite it with a fresh _meta block. Use after
 *                manually editing or backfilling. Stale regions are
 *                NOT auto-stamped — those need regeneration.
 *
 * Exit code: 0 for any successful report (the assistant parses the
 * printed table to decide next steps). Nonzero only on actual failure
 * (design dir missing, parse errors, etc.). "new" and "stale" PNGs
 * are not errors — they're work items.
 *
 * After regenerating the regions for a `new`/`stale` PNG, the
 * assistant should call this script with --stamp to write the hash.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const stamp = args.includes("--stamp");
const dirArg = args.find(a => !a.startsWith("--"));

let designDir = dirArg;
if (!designDir) {
	const configPath = path.resolve(process.cwd(), ".frontend-audit.json");
	if (fs.existsSync(configPath)) {
		try {
			const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
			designDir = cfg.designDir;
		} catch {
			// fall through to default
		}
	}
}
designDir = designDir ?? "design";

if (!fs.existsSync(designDir) || !fs.statSync(designDir).isDirectory()) {
	console.error(`Design directory not found: ${designDir}`);
	process.exit(1);
}

function sha256(filePath) {
	const buf = fs.readFileSync(filePath);
	return crypto.createHash("sha256").update(buf).digest("hex");
}

function regionsPathFor(pngPath) {
	const dir = path.dirname(pngPath);
	const stem = path.basename(pngPath, path.extname(pngPath));
	return path.join(dir, `${stem}.regions.json`);
}

const IMAGE_EXTS = [".png", ".jpg", ".jpeg"];
const pngs = fs
	.readdirSync(designDir)
	.filter(name => IMAGE_EXTS.includes(path.extname(name).toLowerCase()))
	.map(name => path.join(designDir, name));

if (pngs.length === 0) {
	console.log(`No images found in ${designDir}/ (looked for .png, .jpg, .jpeg)`);
	process.exit(0);
}

// PNG-leaning copy: prefer PNG, but JPEG is supported. JPEG's lossy
// compression introduces noise the audit reads as low-confidence
// cluster signatures near edges — re-export as PNG if precision matters.
const jpegCount = pngs.filter(p => p.toLowerCase().match(/\.jpe?g$/)).length;
console.log(`\nScanning ${designDir}/ — ${pngs.length} image(s)`);
if (jpegCount > 0) {
	console.log(
		`(${jpegCount} JPEG file(s) detected — PNG is preferred for lossless ` +
			`sampling; the audit still works on JPEG but tolerances were tuned ` +
			`against PNG inputs)\n`
	);
} else {
	console.log("");
}
const HEADER =
	"Image".padEnd(40) + "Status".padEnd(14) + "Regions file";
console.log(HEADER);
console.log("-".repeat(HEADER.length + 20));

let nonFreshCount = 0;
let stampedCount = 0;

for (const pngPath of pngs) {
	const regionsPath = regionsPathFor(pngPath);
	const pngHash = sha256(pngPath);
	const pngName = path.basename(pngPath);

	let status;
	let regions = null;

	if (!fs.existsSync(regionsPath)) {
		status = "new";
		nonFreshCount++;
	} else {
		try {
			regions = JSON.parse(fs.readFileSync(regionsPath, "utf8"));
			const storedHash = regions._meta?.sourceHash;
			if (!storedHash) {
				status = "unhashed";
			} else if (storedHash === pngHash) {
				status = "up-to-date";
			} else {
				status = "stale";
				nonFreshCount++;
			}
		} catch (err) {
			console.error(`  parse error: ${regionsPath} — ${err.message}`);
			status = "stale";
			nonFreshCount++;
		}
	}

	if (stamp && (status === "up-to-date" || status === "unhashed")) {
		// Re-stamp _meta block on existing regions
		const meta = {
			sourceImage: pngName,
			sourceHash: pngHash,
			generatedAt: new Date().toISOString(),
		};
		const rest = { ...regions };
		delete rest._meta;
		const out = { _meta: meta, ...rest };
		fs.writeFileSync(regionsPath, JSON.stringify(out, null, 2) + "\n");
		status = `${status} → stamped`;
		stampedCount++;
	}

	console.log(
		pngName.padEnd(40) +
			status.padEnd(14) +
			path.relative(process.cwd(), regionsPath)
	);
}

console.log("");
if (nonFreshCount > 0) {
	console.log(`${nonFreshCount} PNG(s) need region generation (new or stale).`);
	console.log(
		"For each: Read the PNG, identify ~10-25 components, write the regions\n" +
			"JSON (no _meta needed). Then run discover --stamp once to record\n" +
			"the hashes."
	);
} else if (stampedCount > 0) {
	console.log(`Stamped ${stampedCount} regions file(s) with the current hash.`);
} else {
	console.log("All PNGs are up-to-date.");
}

// Always exit 0 on successful inventory — the assistant parses the
// printed table to decide what to do. Non-fresh PNGs are work items,
// not errors, so we don't want the shell to surface a red "Error: Exit
// code N" on a normal report.
process.exit(0);
