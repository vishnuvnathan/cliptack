//! A note rendered as HTML for the clipboard, so pasting one into Word, Gmail
//! or a docs editor arrives formatted. The Markdown still goes on alongside it
//! as plain text: that is what a plain-text field, a terminal and Cliptack's own
//! capture read.

use pulldown_cmark::{html, Event, Options, Parser};

/// The GitHub flavour the note editor writes: tables, strikethrough and task
/// lists on top of CommonMark.
fn options() -> Options {
    Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS
}

/// Raw HTML in a note is passed through as text, not markup. The editor never
/// writes any, so whatever is there was typed as Markdown source -- and it is
/// not this function's job to hand a `<script>` or a stray `<div>` to whatever
/// the user pastes into.
pub fn render(markdown: &str) -> String {
    let parser = Parser::new_ext(markdown, options()).map(|event| match event {
        Event::Html(s) | Event::InlineHtml(s) => Event::Text(s),
        other => other,
    });
    let mut out = String::with_capacity(markdown.len() * 3 / 2);
    html::push_html(&mut out, parser);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_the_formatting_the_editor_writes() {
        let out = render("# Plan\n\n- [x] **done** ~~gone~~\n\n| a | b |\n|---|---|\n| 1 | 2 |");
        assert!(out.contains("<h1>Plan</h1>"));
        assert!(out.contains("<strong>done</strong>"));
        assert!(out.contains("<del>gone</del>"));
        assert!(out.contains(r#"<input disabled="" type="checkbox" checked=""/>"#));
        assert!(out.contains("<table>"));
    }

    #[test]
    fn raw_html_is_escaped_not_passed_through() {
        let out = render("hi <script>alert(1)</script>\n\n<div>block</div>");
        assert!(!out.contains("<script>"));
        assert!(!out.contains("<div>"));
        assert!(out.contains("&lt;script&gt;"));
    }
}
