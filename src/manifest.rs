use serde::{Deserialize, Serialize};

pub const FORMAT: &str = "mdparcel";
pub const VERSION: &str = "1.0";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub format: String,
    pub version: String,
    pub title: String,
    pub entry: String,
    pub created_at: String,
    pub generator: String,
    pub assets: Vec<Asset>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Asset {
    pub archive_path: String,
    pub original_path: String,
    pub media_type: String,
    pub size: u64,
    pub sha256: String,
}
