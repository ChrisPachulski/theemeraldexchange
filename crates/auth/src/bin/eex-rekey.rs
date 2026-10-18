//! Move one person's data from one sub to another (the step-3 Plex re-key).
//! Dry run unless --apply. See auth::rekey and DEPLOY.md.

fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (opts, warnings) = match auth::rekey::parse_args(&args) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("eex-rekey: {e}");
            return std::process::ExitCode::from(2);
        }
    };
    for w in warnings {
        eprintln!("{w}");
    }
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    match rt.block_on(auth::rekey::run(&opts)) {
        Ok(lines) => {
            for l in lines {
                println!("{l}");
            }
            std::process::ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("eex-rekey: FAILED: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}
