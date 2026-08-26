# Starship owns the prompt; no zsh framework or theme is required.

if command -v starship >/dev/null 2>&1; then
  eval "$(starship init zsh)"
else
  PROMPT='%F{blue}%~%f %# '
fi
