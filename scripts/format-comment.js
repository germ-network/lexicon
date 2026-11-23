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
    const hasErrors = changes.some((change) => change["lint-level"] === "error");

    output.push(
      hasErrors ? "## ‼️ Incompatible Changes" : "## 🟡 Incompatible Changes",
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
    output.push("## ‼️ DNS Errors");
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
