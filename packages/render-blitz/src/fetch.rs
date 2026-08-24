// SPDX-License-Identifier: MIT OR Apache-2.0
//! Document fetching, and the small amount of HTML sniffing the shell needs
//! before a document exists.

use blitz_traits::net::Request;

/// Fetch a document over Blitz's net provider. Returns the final URL (after
/// redirects) and the body.
///
/// Takes the concrete provider rather than `dyn NetProvider`: the trait is
/// the fire-and-forget interface documents use for sub-resources, and only
/// the concrete type can be awaited for a result.
pub async fn document(
    net: &blitz_net::Provider,
    url: url::Url,
) -> Result<(String, String), String> {
    let (final_url, bytes) = net
        .fetch_async(Request::get(url))
        .await
        .map_err(|e| e.to_string())?;
    let body = String::from_utf8_lossy(bytes.as_ref()).into_owned();
    Ok((final_url, body))
}

/// Pull `<title>` out of a document.
///
/// Blitz parses the document for us, but the title is wanted before the
/// document is installed — and on the WebKit backend it arrives as a signal,
/// so the shell expects it as an event either way. A scan is enough: this is
/// not a parser, and anything it gets wrong is cosmetic.
pub fn title_of(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open = lower.find("<title")?;
    let start = lower[open..].find('>')? + open + 1;
    let end = lower[start..].find("</title>")? + start;
    let title = decode_entities(html[start..end].trim());
    (!title.is_empty()).then_some(title)
}

/// The handful of entities that actually show up in titles.
fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_title_regardless_of_case_or_attributes() {
        assert_eq!(title_of("<TITLE>Shouty</TITLE>").as_deref(), Some("Shouty"));
        assert_eq!(
            title_of("<html><head><title lang=\"en\"> Spaced </title>").as_deref(),
            Some("Spaced")
        );
    }

    #[test]
    fn decodes_the_entities_titles_actually_contain() {
        assert_eq!(
            title_of("<title>Tom &amp; Jerry &lt;3</title>").as_deref(),
            Some("Tom & Jerry <3")
        );
    }

    #[test]
    fn absent_or_empty_titles_are_none() {
        assert_eq!(title_of("<html><body>hi"), None);
        assert_eq!(title_of("<title>   </title>"), None);
        // An unterminated tag must not panic or run off the end.
        assert_eq!(title_of("<title>never closed"), None);
    }
}
