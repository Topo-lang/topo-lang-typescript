#ifndef TOPO_LANG_TYPESCRIPTPLUGIN_H
#define TOPO_LANG_TYPESCRIPTPLUGIN_H

#include "topo/Lang/LanguagePlugin.h"
#include "topo/Lang/CheckRunnerBase.h"
#include "topo/Lang/EmitterFactory.h"
#include "topo/Lang/BuildDriverFactory.h"
#include "TypeScriptInitTemplateProvider.h"

namespace topo::lang {

class TypeScriptPlugin : public LanguagePlugin {
public:
    TypeScriptPlugin();

    HostLanguage language() const override;
    std::unique_ptr<check::LanguageAnalysisProvider> createAnalysisProvider() override;
    EmitterFactory* emitterFactory() override;
    BuildDriverFactory* buildDriverFactory() override;
    InitTemplateProvider* initTemplateProvider() override;
    std::unique_ptr<lsp::LSPBridge> createLSPBridge() override;
    std::unique_ptr<CheckRunnerBase> createCheckRunner() override;

private:
    class TypeScriptEmitterFactory;
    class TypeScriptBuildDriverFactory;
    std::unique_ptr<TypeScriptEmitterFactory> emitterFactory_;
    std::unique_ptr<TypeScriptBuildDriverFactory> buildDriverFactory_;
    TypeScriptInitTemplateProvider initProvider_;
};

/// Call once at startup to register the TypeScript plugin.
void registerTypeScriptPlugin();

} // namespace topo::lang

#endif // TOPO_LANG_TYPESCRIPTPLUGIN_H
