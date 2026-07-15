use std::path::{Component, Path, PathBuf};

/// Finds simple inline Markdown destinations and HTML img src attributes.
/// It deliberately preserves remote URLs, anchors, and data URLs.
pub fn local_destinations(markdown: &str) -> Vec<String> {
    let mut found = Vec::new();
    let bytes = markdown.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b']' && bytes.get(index + 1) == Some(&b'(') {
            if let Some(end) = markdown[index + 2..].find(')') {
                let value = markdown[index + 2..index + 2 + end].trim();
                let destination = value.split_whitespace().next().unwrap_or("");
                if is_local(destination) {
                    found.push(destination.to_owned());
                }
                index += end + 3;
                continue;
            }
        }
        index += 1;
    }
    for quote in ['\'', '\"'] {
        let needle = format!("src={quote}");
        let mut rest = markdown;
        while let Some(start) = rest.find(&needle) {
            let after = &rest[start + needle.len()..];
            if let Some(end) = after.find(quote) {
                let destination = &after[..end];
                if is_local(destination) {
                    found.push(destination.to_owned());
                }
                rest = &after[end + 1..];
            } else {
                break;
            }
        }
    }
    found.sort();
    found.dedup();
    found
}

fn is_local(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('#')
        && !value.starts_with("//")
        && !value.contains("://")
        && !value.starts_with("data:")
}

pub fn safe_relative(value: &str) -> Option<PathBuf> {
    let path = Path::new(value);
    if path.is_absolute() {
        return None;
    }
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    (!clean.as_os_str().is_empty()).then_some(clean)
}

pub fn package_paths(markdown: &str) -> String {
    let mut result = markdown.to_owned();
    for path in local_destinations(markdown) {
        if let Some(clean) = safe_relative(&path) {
            let archive_path = clean.to_string_lossy().replace('\\', "/");
            result = result.replace(&path, &format!("assets/{archive_path}"));
        }
    }
    result
}

pub fn restore_paths(markdown: &str) -> String {
    markdown.replace("assets/", "")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_local_paths_are_collected() {
        let text = "![a](images/a.png) [b](https://x.test) <img src='b.jpg'>";
        assert_eq!(local_destinations(text), vec!["b.jpg", "images/a.png"]);
    }
    #[test]
    fn unsafe_paths_are_rejected() {
        assert!(safe_relative("../secret.png").is_none());
        assert!(safe_relative("images/a.png").is_some());
        assert_eq!(
            safe_relative("./images/a.png"),
            Some(PathBuf::from("images/a.png"))
        );
    }
}
