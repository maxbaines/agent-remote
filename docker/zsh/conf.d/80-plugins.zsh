# Portable plugins mirrored from the host Mac.

export ZSHZ_CASE="${ZSHZ_CASE:-smart}"
export ZSHZ_DATA="${ZSH_STATE_HOME:-$HOME/.config/zsh}/z"
source "$ZSH_CONFIG_HOME/plugins/zsh-z/zsh-z.plugin.zsh"

_zsh_cd_history_complete() {
  emulate -L zsh
  setopt EXTENDED_GLOB NO_SH_WORD_SPLIT

  _cd
  local result=$?
  (( ${compstate[nmatches]:-0} > 0 )) && return $result

  local token="${PREFIX:-}"
  [[ -n "$token" && "$token" != -* ]] || return $result

  local -a matches
  local match
  while IFS= read -r match; do
    [[ -n "$match" ]] && matches+=("$match")
  done < <(zshz --complete -- "$token" 2>/dev/null)

  (( ${#matches[@]} )) || return $result
  compadd -Q -U -X 'zsh-z history dirs' -- "${matches[@]}"
}
compdef _zsh_cd_history_complete cd

export ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='fg=244'
source "$ZSH_CONFIG_HOME/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh"

autoload -Uz add-zsh-hook
_zsh_load_syntax_highlighting() {
  source "$ZSH_CONFIG_HOME/plugins/fast-syntax-highlighting/fast-syntax-highlighting.plugin.zsh"
  typeset -gA FAST_HIGHLIGHT_STYLES
  FAST_HIGHLIGHT_STYLES[comment]='fg=244'
  add-zsh-hook -d precmd _zsh_load_syntax_highlighting
}
add-zsh-hook precmd _zsh_load_syntax_highlighting
