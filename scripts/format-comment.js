const fs = require("node:fs/promises");

/**
 *
 * @param {*} checks
 * @returns {Map<string, { nsid: string, "lint-description": string }[]>}
 */
function groupChecksByFile(checks) {
  return checks.reduce((byFile, check) => {
    const filePath = check["file-path"];
    const checks = byFile.get(filePath) ?? [];

    byFile.set(filePath, checks.concat(check));

    return byFile;
  }, new Map());
}

function formatChecks(checks) {
  const checksByFile = groupChecksByFile(checks);
  const output = [];

  for (let [file, checks] of checksByFile) {
    output.push(`* File: \`${file}\``);
    for (let check of checks) {
      output.push(`  * \`${check.nsid}\`: ${check["lint-description"]}`);
    }
  }

  return output.join("\n");
}

/**
 * Breaking-change issues usually have no "file-path", so group by nsid.
 *
 * @param {{ nsid: string, message: string }[]} changes
 * @returns {string}
 */
function formatChanges(changes) {
  const changesByNsid = changes.reduce((byNsid, change) => {
    const nsidChanges = byNsid.get(change.nsid) ?? [];

    byNsid.set(change.nsid, nsidChanges.concat(change));

    return byNsid;
  }, new Map());
  const output = [];

  for (let [nsid, nsidChanges] of changesByNsid) {
    for (let change of nsidChanges) {
      output.push(`* \`${nsid}\`: ${change.message}`);
    }
  }

  return output.join("\n");
}

// NSIDs come from untrusted PR files, so only render well-formed ones.
const NSID_PATTERN = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

// `goat lex status` prints one " <icon> <nsid>" line per lexicon.
const STATUS_LINE = /^\s*(\S+)\s+(\S+)\s*$/u;
const STATUS_BY_ICON = {
  "🟢": "unchanged",
  "🟣": "changed",
  "🟠": "new",
  "⭕": "remote-only",
};

/**
 * Parse `goat lex status` output into a Map of nsid -> status. Returns null if
 * any non-empty line isn't in the expected format, so callers can say the
 * status couldn't be determined instead of guessing.
 *
 * @param {string} text
 * @returns {Map<string, string> | null}
 */
function parseStatus(text) {
  const statuses = new Map();

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;

    const match = STATUS_LINE.exec(line);
    const status = match && STATUS_BY_ICON[match[1]];
    if (!status || !NSID_PATTERN.test(match[2])) return null;

    statuses.set(match[2], status);
  }

  return statuses;
}

/**
 * "lexicons/com/example/foo.json" -> "com.example.foo"
 *
 * @param {string} path
 * @returns {string | null}
 */
function nsidFromPath(path) {
  const match = /^lexicons\/(.+)\.json$/.exec(path);
  const nsid = match && match[1].split("/").join(".");

  return nsid && NSID_PATTERN.test(nsid) ? nsid : null;
}

/**
 * The "Lexicon Changes" section, or null if the PR touched no lexicon files.
 *
 * @param {{ nsids: unknown[], removed: unknown[] }} lexiconChanges
 * @param {string | null} statusText
 * @returns {string | null}
 */
function formatLexiconChanges(lexiconChanges, statusText) {
  const nsids = lexiconChanges.nsids.filter(
    (nsid) => typeof nsid === "string" && NSID_PATTERN.test(nsid),
  );
  const removed = lexiconChanges.removed
    .filter((path) => typeof path === "string")
    .map(nsidFromPath)
    .filter(Boolean);

  if (!nsids.length && !removed.length) return null;

  const output = ["## 📝 Lexicon Changes"];
  const list = (title, items) => {
    if (!items.length) return;
    output.push(`**${title}**`);
    output.push(items.map((nsid) => `* \`${nsid}\``).join("\n"));
  };

  if (nsids.length) {
    const statuses = statusText === null ? null : parseStatus(statusText);

    if (statuses === null) {
      output.push(
        "Couldn't determine the publish status of the changed lexicons. Check the workflow logs.",
      );
      list("Changed in this PR", nsids);
    } else {
      // Only report NSIDs this PR touched; goat also lists other published
      // lexicons in the same group.
      const byStatus = (status) =>
        nsids.filter((nsid) => statuses.get(nsid) === status);
      const unknown = nsids.filter((nsid) => !statuses.has(nsid));

      list("🟠 New (not yet published)", byStatus("new"));
      list("🟣 Changed (differs from published)", byStatus("changed"));
      list("🟢 Unchanged (matches published)", byStatus("unchanged"));
      list("Status unknown", unknown);
    }
  }

  list("🗑️ Removed in this PR", removed);

  return output.join("\n\n");
}

async function formatComment() {
  const validated = process.env.VALIDATED === "true";
  if (process.env.CI && !validated) {
    return "## ‼️ Error: Workflow failed to run completely";
  }

  let output = [];

  const lint = await fs
    .readFile("logs/lint.json", { encoding: "utf8" })
    .then((text) => JSON.parse(text))
    .catch((err) => {
      return [];
    });
  const changes = await fs
    .readFile("logs/breaking.json", { encoding: "utf8" })
    .then((text) => JSON.parse(text))
    .then((parsed) => (Array.isArray(parsed) ? parsed : []))
    .catch((err) => {
      return [];
    });
  // Written by the workflow only when the breaking check exited non-zero.
  const breakingExitCode = await fs
    .readFile("logs/breaking-exit-code", { encoding: "utf8" })
    .then((text) => text.trim())
    .catch((err) => {
      return null;
    });
  const dns = await fs
    .readFile("logs/check-dns.txt", { encoding: "utf8" })
    .catch((err) => {
      return "";
    });
  const lexiconChanges = await fs
    .readFile("logs/lexicon-changes.json", { encoding: "utf8" })
    .then((text) => JSON.parse(text))
    .then((parsed) => ({
      nsids: Array.isArray(parsed?.nsids) ? parsed.nsids : [],
      removed: Array.isArray(parsed?.removed) ? parsed.removed : [],
    }))
    .catch((err) => {
      return { nsids: [], removed: [] };
    });
  const statusText = await fs
    .readFile("logs/status.txt", { encoding: "utf8" })
    .catch((err) => {
      return null;
    });

  const lexiconSection = formatLexiconChanges(lexiconChanges, statusText);
  if (lexiconSection) {
    output.push(lexiconSection);
  }

  if (lint.length) {
    const errors = lint.filter((check) => check["lint-level"] === "error");
    const warnings = lint.filter((check) => check["lint-level"] === "warn");

    if (errors.length) {
      output.push("## ‼️ Linting Errors");
    } else if (warnings.length) {
      output.push("## 🟡 Linting Warnings");
    } else {
      output.push("## ✅ Linting");
    }

    if (errors.length || warnings.length) {
      const lintOutput = [];

      if (errors.length) {
        lintOutput.push("### Errors:\n");
        lintOutput.push(formatChecks(errors));

        if (warnings.length) lintOutput.push("\n");
      }

      if (warnings.length) {
        lintOutput.push("### Warnings:\n");
        lintOutput.push(formatChecks(warnings));
      }

      output.push(lintOutput.join("\n"));
    } else {
      output.push("No linting issues found.");
    }
  }

  if (changes.length) {
    const hasErrors = changes.some(
      (change) => change["lint-level"] === "error",
    );

    output.push(
      hasErrors ? "## ‼️ Incompatible Changes" : "## 🟡 Incompatible Changes",
    );
    output.push(
      hasErrors
        ? "These changes aren't backwards compatible with the published lexicons: records that are valid today could become invalid, and existing clients may reject new records. Published lexicons should only change in backwards compatible ways, like adding optional fields. For a breaking change, publish a new NSID instead (for example `com.example.fooV2`)."
        : "These changes may not be backwards compatible with the published lexicons. Check that existing records and clients will still work with them.",
    );
    output.push(formatChanges(changes));
  } else if (breakingExitCode !== null) {
    // The file is untrusted, so only print it if it is purely numeric.
    const code = /^[0-9]+$/.test(breakingExitCode)
      ? ` (exit code ${breakingExitCode})`
      : "";

    output.push("## ‼️ Incompatible Changes");
    output.push(
      `The breaking change check failed to run${code}. Check the workflow logs.`,
    );
  } else {
    output.push("## ✅ Incompatible Changes");
    output.push("No breaking changes were detected.");
  }

  if (dns && !dns.includes("successfully")) {
    output.push("## ❌ DNS Errors");
    output.push(`<pre>${dns}</pre>`);
  } else {
    output.push("## ✅ DNS");
    output.push("No DNS issues detected!");
  }

  return output.join("\n\n");
}

module.exports = formatComment;

if (require.main) {
  formatComment().then(console.log);
}
