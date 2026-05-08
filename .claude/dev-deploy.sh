#!/bin/bash
# dev 브랜치에서 git commit 후 jamite-dev 자동 배포
cmd=$(jq -r '.tool_input.command // ""')
if echo "$cmd" | grep -q 'git.*commit'; then
  branch=$(git -C /Users/nz/tennis-tournament rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ "$branch" = "dev" ]; then
    cd /Users/nz/tennis-tournament && firebase deploy --only hosting --project jamite-dev
  fi
fi
