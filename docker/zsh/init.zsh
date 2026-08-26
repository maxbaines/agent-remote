# Self-contained interactive zsh setup, mirrored from the host Mac.

typeset -g ZSH_CONFIG_HOME="$HOME/.config/zsh"

for zsh_config_file in "$ZSH_CONFIG_HOME"/conf.d/*.zsh(N); do
  source "$zsh_config_file"
done

[[ -s "$ZSH_CONFIG_HOME/local.zsh" ]] && source "$ZSH_CONFIG_HOME/local.zsh"

unset zsh_config_file
