# Emacs-style editing, prefix history search, selection, and smart Tab.

bindkey -e

autoload -Uz up-line-or-beginning-search down-line-or-beginning-search
zle -N up-line-or-beginning-search
zle -N down-line-or-beginning-search
zmodload zsh/terminfo 2>/dev/null || true

for zsh_keymap in emacs viins; do
  [[ -n "${terminfo[kcuu1]:-}" ]] && bindkey -M "$zsh_keymap" "${terminfo[kcuu1]}" up-line-or-beginning-search
  [[ -n "${terminfo[kcud1]:-}" ]] && bindkey -M "$zsh_keymap" "${terminfo[kcud1]}" down-line-or-beginning-search
  bindkey -M "$zsh_keymap" '^[[A' up-line-or-beginning-search
  bindkey -M "$zsh_keymap" '^[[B' down-line-or-beginning-search
  bindkey -M "$zsh_keymap" '^[OA' up-line-or-beginning-search
  bindkey -M "$zsh_keymap" '^[OB' down-line-or-beginning-search
done
unset zsh_keymap

_zsh_select_left_char() {
  (( REGION_ACTIVE )) || zle set-mark-command
  zle backward-char
}

_zsh_select_right_char() {
  (( REGION_ACTIVE )) || zle set-mark-command
  zle forward-char
}

_zsh_select_line_start() {
  (( REGION_ACTIVE )) || zle set-mark-command
  zle beginning-of-line
}

_zsh_select_line_end() {
  (( REGION_ACTIVE )) || zle set-mark-command
  zle end-of-line
}

zle -N _zsh_select_left_char
zle -N _zsh_select_right_char
zle -N _zsh_select_line_start
zle -N _zsh_select_line_end

bindkey '^[[1;2D' _zsh_select_left_char
bindkey '^[[1;2C' _zsh_select_right_char
bindkey '^[[1;2H' _zsh_select_line_start
bindkey '^[[1;2F' _zsh_select_line_end
bindkey '^?' backward-delete-char
bindkey '^H' backward-delete-char
bindkey '^[[3~' delete-char
bindkey '^G' send-break

_zsh_smart_tab() {
  emulate -L zsh

  local current_token="${LBUFFER##*[[:space:]]}"
  local trimmed="${LBUFFER#${LBUFFER%%[![:space:]]*}}"

  if [[ -z "$trimmed" || "$trimmed" == *[[:space:]]* || "$current_token" == */* ]]; then
    zle expand-or-complete
  elif (( ${+widgets[autosuggest-accept]} )) && [[ -n "${POSTDISPLAY:-}" ]]; then
    zle autosuggest-accept
  else
    zle expand-or-complete
  fi
}

zle -N _zsh_smart_tab
bindkey '^I' _zsh_smart_tab
