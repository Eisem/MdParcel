use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use mdparcel::archive;

#[derive(Parser)]
#[command(
    name = "mdparcel",
    version,
    about = "Portable Markdown document packages"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Package a Markdown document and its local assets.
    Pack {
        input: PathBuf,
        #[arg(short, long)]
        output: PathBuf,
        /// Warn about missing assets instead of failing.
        #[arg(long)]
        allow_missing: bool,
        /// Replace an existing output archive.
        #[arg(short, long)]
        force: bool,
    },
    /// Show manifest information.
    Info { input: PathBuf },
    /// Validate archive structure and resource integrity.
    Check { input: PathBuf },
    /// Safely restore an archive to a directory.
    Unpack {
        input: PathBuf,
        #[arg(short, long)]
        output: PathBuf,
        #[arg(short, long)]
        force: bool,
    },
    /// Render an MDParcel package to HTML and open it in the default browser.
    View {
        input: PathBuf,
        /// Generate the preview but do not start a browser.
        #[arg(long)]
        no_open: bool,
    },
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Pack {
            input,
            output,
            allow_missing,
            force,
        } => archive::pack(&input, &output, allow_missing, force),
        Command::Info { input } => archive::info(&input),
        Command::Check { input } => archive::check(&input),
        Command::Unpack {
            input,
            output,
            force,
        } => archive::unpack(&input, &output, force),
        Command::View { input, no_open } => archive::view(&input, !no_open),
    }
}
