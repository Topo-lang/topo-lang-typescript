#include "TypeScriptInitTemplateProvider.h"

namespace topo::lang {

std::string TypeScriptInitTemplateProvider::generateTopoToml(const std::string& projectName) const {
    return "[topo]\n"
           "root = \"" + projectName + ".topo\"\n"
           "\n"
           "[build]\n"
           "language = \"typescript\"\n"
           "sources = [\"**/*.ts\"]\n"
           "output = \"" + projectName + "\"\n"
           "\n"
           "[build.backendExtras]\n"
           "nodePath = \"node\"\n"
           "tsconfigPath = \"./tsconfig.json\"\n";
}

std::string TypeScriptInitTemplateProvider::generateTypeBindings() const {
    return "using int = std::typescript::number;\n"
           "using float = std::typescript::number;\n"
           "using bool = std::typescript::boolean;\n"
           "using str = std::typescript::string;\n";
}

} // namespace topo::lang
