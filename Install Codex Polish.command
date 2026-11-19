#!/bin/sh
# Finder's Terminal may have a shorter PATH than the user's development shell.
PATH="${PATH:-/usr/bin:/bin}:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
export PATH
if command -v node >/dev/null 2>&1 && node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || major === 22 && minor >= 16 ? 0 : 1)'; then
    CODEX_POLISH_INSTALL_WINDOW=1
    export CODEX_POLISH_INSTALL_WINDOW
    exec node "$(dirname "$0")/scripts/install.mjs" setup
fi

# Node.js is unavailable, so the shared locale helper cannot run.
ui_locale=${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}
if [ -z "$ui_locale" ] && [ -x /usr/bin/defaults ]; then
    ui_locale=$(/usr/bin/defaults read -g AppleLanguages 2>/dev/null | /usr/bin/sed -n '2s/[",[:space:]]//gp')
fi
case "$ui_locale" in
    [zZ][hH]*)
        printf '%s\n' '安装回复润色需要 Node.js 22.16 或更高版本。装好 Node.js 后，再双击这个文件。' >&2
        close_text='按回车关闭安装窗口。' ;;
    *)
        printf '%s\n' 'Codex Polish needs Node.js 22.16 or later. Install Node.js, then double-click this file again.' >&2
        close_text='Press Enter to close the installer.' ;;
esac
printf '%s\n' 'https://nodejs.org/en/download' >&2
if [ -t 0 ]; then
    printf '\n%s' "$close_text"
    IFS= read -r reply
fi
exit 1
