#include "TypeScriptPlugin.h"

#include "TypeScriptAnalysisProvider.h"
#include "TypeScriptCheckRunner.h"
#include "V8Codegen.h"
#include "TsServerBridge.h"

namespace topo::lang {

// -----------------------------------------------------------------------
// EmitterFactory
// -----------------------------------------------------------------------

class TypeScriptPlugin::TypeScriptEmitterFactory : public EmitterFactory {
public:
    std::unique_ptr<transpile::Emitter> createEmitter() override {
        return std::make_unique<transpile::V8Codegen>();
    }
    std::string fileExtension() const override { return ".ts"; }
};

// -----------------------------------------------------------------------
// BuildDriverFactory
// -----------------------------------------------------------------------

class TypeScriptPlugin::TypeScriptBuildDriverFactory : public BuildDriverFactory {
public:
    std::string backendToolName() const override { return "topo-build-typescript"; }
    std::string extractorToolName() const override { return "topo-extract-typescript"; }
};

// -----------------------------------------------------------------------
// TypeScriptPlugin
// -----------------------------------------------------------------------

TypeScriptPlugin::TypeScriptPlugin()
    : emitterFactory_(std::make_unique<TypeScriptEmitterFactory>()),
      buildDriverFactory_(std::make_unique<TypeScriptBuildDriverFactory>()) {}

HostLanguage TypeScriptPlugin::language() const { return HostLanguage::TypeScript; }

std::unique_ptr<check::LanguageAnalysisProvider> TypeScriptPlugin::createAnalysisProvider() {
    return check::createTypeScriptAnalysisProvider();
}

EmitterFactory* TypeScriptPlugin::emitterFactory() { return emitterFactory_.get(); }
BuildDriverFactory* TypeScriptPlugin::buildDriverFactory() { return buildDriverFactory_.get(); }
InitTemplateProvider* TypeScriptPlugin::initTemplateProvider() { return &initProvider_; }

std::unique_ptr<lsp::LSPBridge> TypeScriptPlugin::createLSPBridge() {
    return std::make_unique<lsp::TsServerBridge>();
}

std::unique_ptr<CheckRunnerBase> TypeScriptPlugin::createCheckRunner() {
    return std::make_unique<TypeScriptCheckRunner>();
}

void registerTypeScriptPlugin() {
    registerPlugin(std::make_unique<TypeScriptPlugin>());
}

} // namespace topo::lang
