# Paths and interactive command defaults.

typeset -U path PATH
for zsh_path_entry in "$HOME/.local/bin" "$HOME/.bun/bin"; do
  [[ -d "$zsh_path_entry" ]] && path=("$zsh_path_entry" $path)
done
unset zsh_path_entry

if command -v nvim >/dev/null 2>&1; then
  export EDITOR="nvim"
elif command -v vim >/dev/null 2>&1; then
  export EDITOR="vim"
else
  export EDITOR="nano"
fi
export VISUAL="$EDITOR"
export STARSHIP_CONFIG="$ZSH_CONFIG_HOME/starship.toml"
export CLICOLOR=1
