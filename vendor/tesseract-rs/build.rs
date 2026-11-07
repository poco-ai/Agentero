#![allow(clippy::uninlined_format_args)]

#[cfg(feature = "build-tesseract")]
mod build_tesseract {
    use cmake::Config;
    use std::env;
    use std::fs;
    use std::path::{Path, PathBuf};

    // Use specific release versions for stability
    const LEPTONICA_URL: &str =
        "https://github.com/DanBloomberg/leptonica/archive/refs/tags/1.84.1.zip";
    const TESSERACT_URL: &str =
        "https://github.com/tesseract-ocr/tesseract/archive/refs/tags/5.3.4.zip";

    fn get_custom_out_dir() -> PathBuf {
        if cfg!(target_os = "macos") {
            let home_dir = env::var("HOME").unwrap_or_else(|_| {
                env::var("USER")
                    .map(|user| format!("/Users/{}", user))
                    .expect("Neither HOME nor USER environment variable set")
            });
            PathBuf::from(home_dir)
                .join("Library")
                .join("Application Support")
                .join("tesseract-rs")
        } else if cfg!(target_os = "linux") {
            let home_dir = env::var("HOME").unwrap_or_else(|_| {
                env::var("USER")
                    .map(|user| format!("/home/{}", user))
                    .expect("Neither HOME nor USER environment variable set")
            });
            PathBuf::from(home_dir).join(".tesseract-rs")
        } else if cfg!(target_os = "windows") {
            env::var("APPDATA")
                .or_else(|_| env::var("USERPROFILE").map(|p| format!("{}\\AppData\\Roaming", p)))
                .map(PathBuf::from)
                .expect("Neither APPDATA nor USERPROFILE environment variable set")
                .join("tesseract-rs")
        } else {
            panic!("Unsupported operating system");
        }
    }

    pub fn build() {
        let custom_out_dir = get_custom_out_dir();
        std::fs::create_dir_all(&custom_out_dir).expect("Failed to create custom out directory");

        println!("cargo:warning=custom_out_dir: {:?}", custom_out_dir);

        let cache_dir = custom_out_dir.join("cache");

        if env::var("CARGO_CLEAN").is_ok() {
            clean_cache(&cache_dir);
        }

        std::fs::create_dir_all(&cache_dir).expect("Failed to create cache directory");

        let out_dir = custom_out_dir.clone();
        let project_dir = custom_out_dir.clone();
        let third_party_dir = project_dir.join("third_party");

        let leptonica_dir = if third_party_dir.join("leptonica").exists() {
            println!("cargo:warning=Using existing leptonica source");
            third_party_dir.join("leptonica")
        } else {
            fs::create_dir_all(&third_party_dir).expect("Failed to create third_party directory");
            download_and_extract(&third_party_dir, LEPTONICA_URL, "leptonica")
        };

        let tesseract_dir = if third_party_dir.join("tesseract").exists() {
            println!("cargo:warning=Using existing tesseract source");
            third_party_dir.join("tesseract")
        } else {
            fs::create_dir_all(&third_party_dir).expect("Failed to create third_party directory");
            download_and_extract(&third_party_dir, TESSERACT_URL, "tesseract")
        };

        let (cmake_cxx_flags, additional_defines) = get_os_specific_config();

        let leptonica_install_dir = out_dir.join("leptonica");
        let leptonica_cache_dir = cache_dir.join("leptonica");

        build_or_use_cached(
            "leptonica",
            &leptonica_cache_dir,
            &leptonica_install_dir,
            || {
                let mut leptonica_config = Config::new(&leptonica_dir);

                let leptonica_src_dir = leptonica_dir.join("src");
                let environ_h_path = leptonica_src_dir.join("environ.h");

                // Only modify environ.h if it exists
                if environ_h_path.exists() {
                    let environ_h = std::fs::read_to_string(&environ_h_path)
                        .expect("Failed to read environ.h")
                        .replace(
                            "#define  HAVE_LIBZ          1",
                            "#define  HAVE_LIBZ          0",
                        )
                        .replace(
                            "#ifdef  NO_CONSOLE_IO",
                            "#define NO_CONSOLE_IO\n#ifdef  NO_CONSOLE_IO",
                        );
                    std::fs::write(environ_h_path, environ_h).expect("Failed to write environ.h");
                }

                let makefile_static_path = leptonica_dir.join("prog").join("makefile.static");

                // Only modify makefile.static if it exists
                if makefile_static_path.exists() {
                    let makefile_static = std::fs::read_to_string(&makefile_static_path)
                        .expect("Failed to read makefile.static")
                        .replace(
                            "ALL_LIBS =	$(LEPTLIB) -ltiff -ljpeg -lpng -lz -lm",
                            "ALL_LIBS =	$(LEPTLIB) -lm",
                        );
                    std::fs::write(makefile_static_path, makefile_static)
                        .expect("Failed to write makefile.static");
                }

                // Configure build tools
                if cfg!(target_os = "windows") {
                    // Use NMake on Windows for better compatibility
                    if let Ok(_vs_install_dir) = env::var("VSINSTALLDIR") {
                        leptonica_config.generator("NMake Makefiles");
                    }
                }

                // Only use sccache if not in CI
                if env::var("CI").is_err()
                    && env::var("RUSTC_WRAPPER").unwrap_or_default() == "sccache"
                {
                    leptonica_config
                        .env("CC", "sccache cc")
                        .env("CXX", "sccache c++");
                }
                leptonica_config
                    .define("CMAKE_POLICY_VERSION_MINIMUM", "3.5")
                    .define("CMAKE_BUILD_TYPE", "Release")
                    .define("BUILD_PROG", "OFF")
                    .define("BUILD_SHARED_LIBS", "OFF")
                    .define("ENABLE_ZLIB", "OFF")
                    .define("ENABLE_PNG", "OFF")
                    .define("ENABLE_JPEG", "OFF")
                    .define("ENABLE_TIFF", "OFF")
                    .define("ENABLE_WEBP", "OFF")
                    .define("ENABLE_OPENJPEG", "OFF")
                    .define("ENABLE_GIF", "OFF")
                    .define("NO_CONSOLE_IO", "ON")
                    .define("CMAKE_CXX_FLAGS", &cmake_cxx_flags)
                    .define("MINIMUM_SEVERITY", "L_SEVERITY_NONE")
                    .define("SW_BUILD", "OFF")
                    .define("HAVE_LIBZ", "0")
                    .define("ENABLE_LTO", "OFF")
                    .define("CMAKE_INSTALL_PREFIX", &leptonica_install_dir);

                // Windows-specific defines
                if cfg!(target_os = "windows") {
                    leptonica_config
                        .define("CMAKE_C_FLAGS_RELEASE", "/MD /O2")
                        .define("CMAKE_C_FLAGS_DEBUG", "/MDd /Od");
                }

                for (key, value) in &additional_defines {
                    leptonica_config.define(key, value);
                }

                leptonica_config.build();
            },
        );

        let leptonica_include_dir = leptonica_install_dir.join("include");
        let leptonica_lib_dir = leptonica_install_dir.join("lib");
        let tesseract_install_dir = out_dir.join("tesseract");
        let tesseract_cache_dir = cache_dir.join("tesseract");
        let tessdata_prefix = project_dir.join("tessdata");

        build_or_use_cached(
            "tesseract",
            &tesseract_cache_dir,
            &tesseract_install_dir,
            || {
                let cmakelists_path = tesseract_dir.join("CMakeLists.txt");
                let cmakelists = std::fs::read_to_string(&cmakelists_path)
                    .expect("Failed to read CMakeLists.txt")
                    .replace("set(HAVE_TIFFIO_H ON)", "");
                std::fs::write(&cmakelists_path, cmakelists)
                    .expect("Failed to write CMakeLists.txt");

                let mut tesseract_config = Config::new(&tesseract_dir);
                // Configure build tools
                if cfg!(target_os = "windows") {
                    // Use NMake on Windows for better compatibility
                    if let Ok(_vs_install_dir) = env::var("VSINSTALLDIR") {
                        tesseract_config.generator("NMake Makefiles");
                    }
                }

                // Only use sccache if not in CI
                if env::var("CI").is_err()
                    && env::var("RUSTC_WRAPPER").unwrap_or_default() == "sccache"
                {
                    tesseract_config
                        .env("CC", "sccache cc")
                        .env("CXX", "sccache c++");
                }
                tesseract_config
                    .define("CMAKE_POLICY_VERSION_MINIMUM", "3.5")
                    .define("CMAKE_BUILD_TYPE", "Release")
                    .define("BUILD_TRAINING_TOOLS", "OFF")
                    .define("BUILD_SHARED_LIBS", "OFF")
                    .define("DISABLE_ARCHIVE", "ON")
                    .define("DISABLE_CURL", "ON")
                    .define("DISABLE_OPENCL", "ON")
                    .define("Leptonica_DIR", &leptonica_install_dir)
                    .define("LEPTONICA_INCLUDE_DIR", &leptonica_include_dir)
                    .define("LEPTONICA_LIBRARY", &leptonica_lib_dir)
                    .define("CMAKE_PREFIX_PATH", &leptonica_install_dir)
                    .define("CMAKE_INSTALL_PREFIX", &tesseract_install_dir)
                    .define("TESSDATA_PREFIX", &tessdata_prefix)
                    .define("DISABLE_TIFF", "ON")
                    .define("DISABLE_PNG", "ON")
                    .define("DISABLE_JPEG", "ON")
                    .define("DISABLE_WEBP", "ON")
                    .define("DISABLE_OPENJPEG", "ON")
                    .define("DISABLE_ZLIB", "ON")
                    .define("DISABLE_LIBXML2", "ON")
                    .define("DISABLE_LIBICU", "ON")
                    .define("DISABLE_LZMA", "ON")
                    .define("DISABLE_GIF", "ON")
                    .define("DISABLE_DEBUG_MESSAGES", "ON")
                    .define("debug_file", "/dev/null")
                    .define("HAVE_LIBARCHIVE", "OFF")
                    .define("HAVE_LIBCURL", "OFF")
                    .define("HAVE_TIFFIO_H", "OFF")
                    .define("GRAPHICS_DISABLED", "ON")
                    .define("DISABLED_LEGACY_ENGINE", "OFF")
                    .define("USE_OPENCL", "OFF")
                    .define("OPENMP_BUILD", "OFF")
                    .define("BUILD_TESTS", "OFF")
                    .define("ENABLE_LTO", "OFF")
                    .define("BUILD_PROG", "OFF")
                    .define("SW_BUILD", "OFF")
                    .define("LEPT_TIFF_RESULT", "FALSE")
                    .define("INSTALL_CONFIGS", "ON")
                    .define("USE_SYSTEM_ICU", "ON")
                    .define("CMAKE_CXX_FLAGS", &cmake_cxx_flags);

                for (key, value) in &additional_defines {
                    tesseract_config.define(key, value);
                }

                tesseract_config.build();
            },
        );

        println!("cargo:rerun-if-changed=build.rs");
        println!("cargo:rerun-if-changed={}", third_party_dir.display());
        println!("cargo:rerun-if-changed={}", leptonica_dir.display());
        println!("cargo:rerun-if-changed={}", tesseract_dir.display());

        println!(
            "cargo:rustc-link-search=native={}",
            leptonica_lib_dir.display()
        );
        println!(
            "cargo:rustc-link-search=native={}",
            tesseract_install_dir.join("lib").display()
        );
        // Don't emit link directives here - let build_or_use_cached handle it

        set_os_specific_link_flags();

        println!(
            "cargo:warning=Leptonica include dir: {:?}",
            leptonica_include_dir
        );
        println!("cargo:warning=Leptonica lib dir: {:?}", leptonica_lib_dir);
        println!(
            "cargo:warning=Tesseract install dir: {:?}",
            tesseract_install_dir
        );
        println!("cargo:warning=Tessdata dir: {:?}", tessdata_prefix);

        download_tessdata(&project_dir);
    }

    fn get_os_specific_config() -> (String, Vec<(String, String)>) {
        let mut cmake_cxx_flags = String::new();
        let mut additional_defines = Vec::new();

        if cfg!(target_os = "macos") {
            cmake_cxx_flags.push_str("-stdlib=libc++ ");
            cmake_cxx_flags.push_str("-std=c++11 ");
        } else if cfg!(target_os = "linux") {
            cmake_cxx_flags.push_str("-std=c++11 ");
            // Check if we're on a system using clang
            if cfg!(target_env = "musl")
                || env::var("CC")
                    .map(|cc| cc.contains("clang"))
                    .unwrap_or(false)
            {
                cmake_cxx_flags.push_str("-stdlib=libc++ ");
                additional_defines.push(("CMAKE_CXX_COMPILER".to_string(), "clang++".to_string()));
            } else {
                // Assume GCC
                additional_defines.push(("CMAKE_CXX_COMPILER".to_string(), "g++".to_string()));
            }
        } else if cfg!(target_os = "windows") {
            // Windows-specific MSVC flags
            cmake_cxx_flags.push_str("/EHsc /MP /std:c++17 ");
            additional_defines.push(("CMAKE_CXX_FLAGS_RELEASE".to_string(), "/MD /O2".to_string()));
            additional_defines.push(("CMAKE_CXX_FLAGS_DEBUG".to_string(), "/MDd /Od".to_string()));
            additional_defines.push((
                "CMAKE_WINDOWS_EXPORT_ALL_SYMBOLS".to_string(),
                "ON".to_string(),
            ));
            additional_defines.push((
                "CMAKE_MSVC_RUNTIME_LIBRARY".to_string(),
                "MultiThreadedDLL".to_string(),
            ));
        }

        // Common flags and defines for all platforms
        cmake_cxx_flags.push_str("-DUSE_STD_NAMESPACE ");
        additional_defines.push((
            "CMAKE_POSITION_INDEPENDENT_CODE".to_string(),
            "ON".to_string(),
        ));

        (cmake_cxx_flags, additional_defines)
    }

    fn set_os_specific_link_flags() {
        if cfg!(target_os = "macos") {
            println!("cargo:rustc-link-lib=c++");
        } else if cfg!(target_os = "linux") {
            if cfg!(target_env = "musl")
                || env::var("CC")
                    .map(|cc| cc.contains("clang"))
                    .unwrap_or(false)
            {
                println!("cargo:rustc-link-lib=c++");
            } else {
                println!("cargo:rustc-link-lib=stdc++");
            }
            println!("cargo:rustc-link-lib=pthread");
            println!("cargo:rustc-link-lib=m");
            println!("cargo:rustc-link-lib=dl");
        } else if cfg!(target_os = "windows") {
            // Additional linker flags are generally not required for Windows,
            // as MSVC automatically links the necessary libraries.
            // However, for some special cases, additions can be made as follows:
            // println!("cargo:rustc-link-lib=user32");
            // println!("cargo:rustc-link-lib=gdi32");
        }

        println!(
            "cargo:rustc-link-search=native={}",
            env::var("OUT_DIR").unwrap()
        );
    }

    fn download_and_extract(target_dir: &Path, url: &str, name: &str) -> PathBuf {
        use reqwest::blocking::Client;
        use zip::ZipArchive;

        fs::create_dir_all(target_dir).expect("Failed to create target directory");

        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .expect("Failed to create HTTP client");

        println!("cargo:warning=Downloading {} from {}", name, url);
        let mut response = client.get(url).send().expect("Failed to download archive");

        if !response.status().is_success() {
            panic!("Failed to download {}: HTTP {}", name, response.status());
        }

        let mut content = Vec::new();
        response
            .copy_to(&mut content)
            .expect("Failed to read archive content");

        println!(
            "cargo:warning=Downloaded {} bytes for {}",
            content.len(),
            name
        );

        let temp_file = target_dir.join(format!("{}.zip", name));
        fs::write(&temp_file, content).expect("Failed to write archive to file");

        let extract_dir = target_dir.join(name);
        if extract_dir.exists() {
            fs::remove_dir_all(&extract_dir).expect("Failed to remove existing directory");
        }
        fs::create_dir_all(&extract_dir).expect("Failed to create extraction directory");

        let mut archive = ZipArchive::new(fs::File::open(&temp_file).unwrap()).unwrap();

        // Extract files, ignoring the top-level directory
        for i in 0..archive.len() {
            let mut file = archive.by_index(i).unwrap();
            let file_path = file.mangled_name().unwrap();
            let file_path = file_path.to_str().unwrap();

            // Skip the top-level directory
            let path = Path::new(file_path);
            let path = path
                .strip_prefix(path.components().next().unwrap())
                .unwrap();

            if path.as_os_str().is_empty() {
                continue;
            }

            let target_path = extract_dir.join(path);

            if file.is_dir() {
                fs::create_dir_all(target_path).unwrap();
            } else {
                if let Some(parent) = target_path.parent() {
                    fs::create_dir_all(parent).unwrap();
                }
                let mut outfile = fs::File::create(target_path).unwrap();
                std::io::copy(&mut file, &mut outfile).unwrap();
            }
        }

        fs::remove_file(temp_file).expect("Failed to remove temporary zip file");

        extract_dir
    }

    fn download_tessdata(project_dir: &Path) {
        let tessdata_dir = project_dir.join("tessdata");
        fs::create_dir_all(&tessdata_dir).expect("Failed to create Tessdata directory");

        let languages = ["eng", "tur"];
        let base_url = "https://github.com/tesseract-ocr/tessdata_best/raw/main/";
        let client = reqwest::blocking::Client::new();

        for lang in &languages {
            let filename = format!("{}.traineddata", lang);
            let file_path = tessdata_dir.join(&filename);

            if !file_path.exists() {
                let url = format!("{}{}", base_url, filename);
                let response = client
                    .get(&url)
                    .send()
                    .expect("Failed to download Tessdata");
                let mut dest = fs::File::create(&file_path).expect("Failed to create file");
                std::io::copy(
                    &mut response
                        .bytes()
                        .expect("Failed to get response bytes")
                        .as_ref(),
                    &mut dest,
                )
                .expect("Failed to write Tessdata");
                println!("cargo:warning={} downloaded", filename);
            } else {
                println!(
                    "cargo:warning={} already exists, skipping download",
                    filename
                );
            }
        }
    }

    fn clean_cache(cache_dir: &Path) {
        println!("Cleaning cache directory: {:?}", cache_dir);
        if cache_dir.exists() {
            fs::remove_dir_all(cache_dir).expect("Failed to remove cache directory");
        }
    }

    fn build_or_use_cached<F>(name: &str, cache_dir: &Path, install_dir: &Path, build_fn: F)
    where
        F: FnOnce(),
    {
        // Expected library name for caching
        let lib_name = if cfg!(target_os = "windows") {
            format!("{}.lib", name)
        } else {
            format!("lib{}.a", name)
        };

        let cached_path = cache_dir.join(&lib_name);
        let out_path = install_dir.join("lib").join(&lib_name);

        // For Windows, check multiple possible library names
        let possible_lib_names: Vec<String> = if cfg!(target_os = "windows") {
            match name {
                "leptonica" => vec![
                    "leptonica.lib".to_string(),
                    "libleptonica.lib".to_string(),
                    "leptonica-static.lib".to_string(),
                    "leptonica-1.84.1.lib".to_string(),
                ],
                "tesseract" => vec![
                    "tesseract.lib".to_string(),
                    "libtesseract.lib".to_string(),
                    "tesseract-static.lib".to_string(),
                    "tesseract53.lib".to_string(),
                    "tesseract54.lib".to_string(),
                ],
                _ => vec![format!("{}.lib", name)],
            }
        } else {
            vec![format!("lib{}.a", name)]
        };

        fs::create_dir_all(cache_dir).expect("Failed to create cache directory");
        fs::create_dir_all(out_path.parent().unwrap()).expect("Failed to create output directory");

        if cached_path.exists() {
            println!("Using cached {} library", name);
            if let Err(e) = fs::copy(&cached_path, &out_path) {
                println!("cargo:warning=Failed to copy cached library: {}", e);
                // If cache copy fails, rebuild
                build_fn();
            }
        } else {
            println!("Building {} library", name);
            build_fn();

            // Look for the library with various possible names
            let mut found_lib_path = None;
            for lib_name in &possible_lib_names {
                let lib_path = install_dir.join("lib").join(lib_name);
                if lib_path.exists() {
                    println!(
                        "cargo:warning=Found {} library at: {}",
                        name,
                        lib_path.display()
                    );
                    found_lib_path = Some(lib_path);
                    break;
                }
            }

            if let Some(lib_path) = found_lib_path {
                // Copy to expected location for caching
                if !out_path.exists() {
                    if let Err(e) = fs::copy(&lib_path, &out_path) {
                        println!(
                            "cargo:warning=Failed to copy library to standard location: {}",
                            e
                        );
                    }
                }
                // Cache the library
                if let Err(e) = fs::copy(&lib_path, &cached_path) {
                    println!("cargo:warning=Failed to cache library: {}", e);
                }
            } else {
                println!(
                    "cargo:warning=Library {} not found! Searched for: {:?}",
                    name, possible_lib_names
                );
                println!(
                    "cargo:warning=In directory: {}",
                    install_dir.join("lib").display()
                );
                // List files in lib directory for debugging
                if let Ok(entries) = fs::read_dir(install_dir.join("lib")) {
                    println!("cargo:warning=Files in lib directory:");
                    for entry in entries.flatten() {
                        println!("cargo:warning=  - {}", entry.file_name().to_string_lossy());
                    }
                }
            }
        }

        println!(
            "cargo:rustc-link-search=native={}",
            install_dir.join("lib").display()
        );

        println!("cargo:rustc-link-lib=static={}", name);

        // For Windows, try alternative names if primary fails
        if cfg!(target_os = "windows") && name == "leptonica" {
            println!("cargo:rustc-link-lib=static=leptonica-1.84.1");
        } else if cfg!(target_os = "windows") && name == "tesseract" {
            println!("cargo:rustc-link-lib=static=tesseract53");
        }
    }
}

fn main() {
    #[cfg(feature = "build-tesseract")]
    build_tesseract::build();
}
