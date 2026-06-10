// The provider's symbol-extractor choice silently changed verdict quality
// when the Node AST extractor was missing (regex fallback). The
// no-silent-degradation principle requires the switch to be visible by
// default — this pins the once-per-process stderr notice.
//
// NOTE: the notice fires once per process, so this file must stay the only
// test in topo-lang-typescript-tests that calls createSymbolExtractor()
// with the extractor unavailable; a second caller would consume the
// once-flag before the capture below depending on run order.

#include "TypeScriptAnalysisProvider.h"

#include <gtest/gtest.h>

#include <cstdlib>
#include <string>

#ifdef _WIN32
#define topo_putenv(k, v) _putenv_s(k, v)
#else
#define topo_putenv(k, v) ::setenv(k, v, 1)
#endif

namespace {

// Save/restore PATH across the test (same idiom as topo-core TempFileTest).
class ScopedPath {
public:
    explicit ScopedPath(const char* value) {
        const char* prev = std::getenv("PATH");
        prev_ = prev ? prev : "";
        topo_putenv("PATH", value);
    }
    ~ScopedPath() { topo_putenv("PATH", prev_.c_str()); }
private:
    std::string prev_;
};

} // namespace

TEST(TypeScriptProviderFallbackNotice, RegexFallbackPrintsOnceVisibly) {
    // Gut PATH so the topo-extract-typescript launcher cannot resolve and
    // the provider must take the regex fallback branch.
    ScopedPath path("");
    // Factory, not stack construction: TsServerBridge is only forward-
    // declared in the header, so the provider must be created (and thus
    // destroyed) inside the TU where the bridge type is complete.
    auto provider = topo::check::createTypeScriptAnalysisProvider();
    ASSERT_NE(provider, nullptr);

    testing::internal::CaptureStderr();
    auto first = provider->createSymbolExtractor();
    std::string firstErr = testing::internal::GetCapturedStderr();

    ASSERT_NE(first, nullptr);
    EXPECT_NE(firstErr.find("topo-extract-typescript not found"), std::string::npos)
        << "regex fallback must announce itself by default, got: " << firstErr;
    EXPECT_NE(firstErr.find("regex-grade"), std::string::npos);

    // Once per process: a second fallback selection stays quiet.
    testing::internal::CaptureStderr();
    auto second = provider->createSymbolExtractor();
    std::string secondErr = testing::internal::GetCapturedStderr();
    ASSERT_NE(second, nullptr);
    EXPECT_EQ(secondErr.find("topo-extract-typescript"), std::string::npos)
        << "notice must not repeat on every extraction, got: " << secondErr;
}
