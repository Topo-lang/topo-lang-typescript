# TopoLangTypeScriptCompilerFlags.cmake — standalone compiler-flag helper for topo-lang-typescript.

if(NOT WIN32)
    set(CMAKE_INSTALL_RPATH_USE_LINK_PATH TRUE)
    if(APPLE)
        set(CMAKE_MACOSX_RPATH ON)
    endif()
endif()

set(TOPO_LANG_TYPESCRIPT_SANITIZER "" CACHE STRING
    "Enable sanitizers (address, undefined, thread, memory)")

function(topo_lang_typescript_apply_sanitizer target)
    if(NOT TOPO_LANG_TYPESCRIPT_SANITIZER)
        return()
    endif()
    if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
        target_compile_options(${target}
            PRIVATE -fsanitize=${TOPO_LANG_TYPESCRIPT_SANITIZER} -fno-omit-frame-pointer)
        target_link_options(${target}
            PRIVATE -fsanitize=${TOPO_LANG_TYPESCRIPT_SANITIZER})
    endif()
endfunction()

function(topo_set_compiler_flags target)
    target_compile_features(${target} PUBLIC cxx_std_17)
    set_target_properties(${target} PROPERTIES CXX_EXTENSIONS OFF)
    if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
        target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic)
    elseif(MSVC)
        target_compile_options(${target} PRIVATE /W4)
    endif()
    topo_lang_typescript_apply_sanitizer(${target})
endfunction()

function(topo_set_llvm_flags target)
    # topo-lang-typescript doesn't link LLVM — TypeScript has no LLVM backend
    # in Topo. The helper exists for symmetry with topo-lang-cpp/topo-lang-rust
    # so vendored subdir CMakeLists that conditionally call it still configure.
    topo_set_compiler_flags(${target})
endfunction()

if(NOT COMMAND topo_apply_std_pch)
    function(topo_apply_std_pch target)
        # PCH stub — no-op in standalone topo-lang-typescript.
        # Guarded so the meta-repo unified build (which defines the real
        # topo_apply_std_pch) wins over this stub when this CMakeLists is
        # included via add_subdirectory.
    endfunction()
endif()
