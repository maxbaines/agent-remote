# Cached completion with additional community completion definitions.

fpath=("$ZSH_CONFIG_HOME/plugins/zsh-completions/src" $fpath)

typeset -g ZSH_CACHE_HOME="$HOME/.cache/zsh"
typeset -g ZSH_COMPDUMP="$ZSH_CACHE_HOME/zcompdump-${ZSH_VERSION}"
mkdir -p "$ZSH_CACHE_HOME"

autoload -Uz compinit
if [[ ! -s "$ZSH_COMPDUMP" || -n "$ZSH_COMPDUMP"(#qN.mh+24) ]]; then
  compinit -d "$ZSH_COMPDUMP"
else
  compinit -C -d "$ZSH_COMPDUMP"
fi

[[ -s "$HOME/.bun/_bun" ]] && source "$HOME/.bun/_bun"
