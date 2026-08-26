# Shared, deduplicated history across terminal sessions.

typeset -g ZSH_STATE_HOME="${XDG_CONFIG_HOME:-$HOME/.config}/zsh"
mkdir -p "$ZSH_STATE_HOME"

HISTFILE="$ZSH_STATE_HOME/history"
HISTSIZE=50000
SAVEHIST=50000

setopt APPEND_HISTORY
setopt EXTENDED_HISTORY
setopt HIST_FIND_NO_DUPS
setopt HIST_IGNORE_ALL_DUPS
setopt HIST_IGNORE_SPACE
setopt HIST_REDUCE_BLANKS
setopt SHARE_HISTORY
