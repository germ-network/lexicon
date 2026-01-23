const fs = require("node:fs/promises");

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
    .readFile("logs/breaking-changes.txt", { encoding: "utf8" })
    .catch((err) => {
      return "";
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
        errors.forEach((check) => {
          lintOutput.push(
            `* \`${check.nsid}\`: ${check["lint-description"]} in \`${check["file-path"]}\``,
          );
        });

        if (warnings.length) lintOutput.push("\n");
      }

      if (warnings.length) {
        lintOutput.push("### Warnings:\n");
        warnings.forEach((check) => {
          lintOutput.push(
            `* \`${check.nsid}\`: ${check["lint-description"]} in \`${check["file-path"]}\``,
          );
        });
      }

      output.push(lintOutput.join("\n"));
    } else {
      output.push("No linting issues found.");
    }
  }

  if (changes) {
    if (changes.includes("error")) {
      output.push("## ‼️ Incompatible Changes");
      output.push(`<pre>${changes}</pre>`);
    } else {
      output.push("## 🟡 Incompatible Changes");
      output.push(
        `<details><summary>Received non-error output:</summary><pre>${changes}</pre></details>`,
      );
    }
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
