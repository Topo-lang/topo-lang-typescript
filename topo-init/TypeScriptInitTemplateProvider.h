#ifndef TOPO_LANG_TYPESCRIPT_INITTEMPLATEPROVIDER_H
#define TOPO_LANG_TYPESCRIPT_INITTEMPLATEPROVIDER_H

#include "topo/Lang/InitTemplateProvider.h"

namespace topo::lang {

class TypeScriptInitTemplateProvider : public InitTemplateProvider {
public:
    std::string languageName() const override { return "typescript"; }

    std::vector<std::string> filePatterns() const override {
        return {"*.ts", "*.tsx"};
    }

    /// Default glob for [build].sources. src/-rooted to match TopoGenerator
    /// (the live `topo init` generator) and the Cpp/Rust providers; was
    /// "**/*.ts" (root-recursive). We return the `.ts` glob alone; projects
    /// that include `.tsx` should add `src/**/*.tsx` to their Topo.toml sources
    /// list.
    std::string sourceFileGlob() const override { return "src/**/*.ts"; }

    std::string generateTopoToml(const std::string& projectName) const override;
    std::string generateTypeBindings() const override;
};

} // namespace topo::lang

#endif // TOPO_LANG_TYPESCRIPT_INITTEMPLATEPROVIDER_H
