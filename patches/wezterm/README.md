# WezTerm Fork Notes

This directory contains the minimal patch set that `claude2bot` needs in order to
support a clean "background mux session -> later GUI attach" flow.

## Current problem

When WezTerm GUI starts in attach/connect mode, the current upstream flow in
`wezterm-gui/src/main.rs` still builds an empty window before attaching to the
domain. In our testing this can lead to transient or duplicate empty tabs/panes
when surfacing an existing background session.

## Patch

- `0001-attach-existing-domain-without-empty-window.patch`

This patch changes `spawn_tab_in_domain_if_mux_is_empty()` so that:

- if GUI is connecting/attaching
- and the target domain/workspace already has panes

then WezTerm attaches directly with `domain.attach(None)` and returns without
creating an empty placeholder window first.

## Intended effect

- `hide` mode remains fully background-only
- `view` mode can surface the existing background pane instead of spawning a new
  empty shell pane/tab

## Upstream target

- Repository: `https://github.com/wez/wezterm`
- File: `wezterm-gui/src/main.rs`
