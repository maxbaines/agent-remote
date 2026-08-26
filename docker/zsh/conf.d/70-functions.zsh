# Launch Yazi and follow its final working directory when it exits.

y() {
  emulate -L zsh
  setopt LOCAL_OPTIONS NO_SH_WORD_SPLIT

  local cwd_file selected_dir
  cwd_file="$(mktemp -t 'yazi-cwd.XXXXXX')" || return
  command yazi "$@" --cwd-file="$cwd_file"

  if selected_dir="$(command cat -- "$cwd_file")" && [[ -n "$selected_dir" && "$selected_dir" != "$PWD" ]]; then
    builtin cd -- "$selected_dir"
  fi

  command rm -f -- "$cwd_file"
}
