#!/bin/bash
# Validate an agent skill against the Agent Skills specification using pi itself.
#
# A headless pi agent performs the validation (reading files, measuring lengths
# with its tools) instead of re-implementing spec checks in bash. Pi's own skill
# loader is lenient and only warns in the TUI, so this script enforces the
# stricter standard at authoring time.
#
# Note: the validator agent reads the skill's content. Review third-party
# skills before validating them - skill content can instruct the agent.
#
# Usage: validate_skill.sh <skill-directory>
# Exit codes: 0 = PASS, 1 = FAIL, 2 = usage/dependency error

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: validate_skill.sh <skill-directory>" >&2
  exit 2
fi

if [[ ! -d $1 ]]; then
  echo "error: not a directory: $1" >&2
  exit 2
fi

if ! command -v pi >/dev/null; then
  echo "error: pi is not installed" >&2
  exit 2
fi

skill_dir="$(cd "$1" && pwd)"

prompt=$(cat <<EOF
Validate the agent skill at $skill_dir against the Agent Skills specification.

List the directory and read SKILL.md. Use your tools (read, bash with grep/wc/awk) for exact measurements - never estimate character counts or line counts.

Checks:
1. SKILL.md exists and starts immediately with YAML frontmatter (--- ... ---) forming a valid YAML mapping
2. name: present, max 64 chars, only lowercase a-z, digits, hyphens; no leading/trailing hyphen; no consecutive hyphens; exactly matches the directory name
3. description: present, max 1024 chars, no angle brackets, written in third person, includes trigger phrases (e.g. "Use when ...")
4. Body: max 500 lines, imperative voice, consistent terminology
5. Directories mentioned in the body (references/, scripts/, assets/) exist
6. No extraneous files (README.md, CHANGELOG.md, etc.)
7. File references use \${CLAUDE_SKILL_ROOT}/... instead of hardcoded paths

Report each check as PASS, WARN, or FAIL with a one-line reason. The last line of your response must be exactly one of:
RESULT: PASS
RESULT: FAIL
RESULT: PASS only when there are no FAILs; warnings alone do not fail.
EOF
)

output="$(pi --no-skills --no-extensions --no-context-files --no-session --thinking off -p "$prompt")"

echo "$output"
[[ $(echo "$output" | tail -n1) == "RESULT: PASS" ]]
