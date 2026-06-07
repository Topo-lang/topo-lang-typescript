#include "TypeScriptInitTemplateProvider.h"

namespace topo::lang {

std::string TypeScriptInitTemplateProvider::generateTopoToml(const std::string& projectName) const {
    // Realigned to match TopoGenerator::generateTopoToml (the live `topo init`
    // generator) and the Cpp/Rust providers: a [project] section with `name`,
    // root = "topo/main.topo" (not "<name>.topo"), the src-rooted sources glob
    // from sourceFileGlob() (not the inline "**/*.ts"), and a [completeness]
    // section. The TS-specific [build.backendExtras] (nodePath / tsconfigPath)
    // is preserved — TopoGenerator omits it, but it carries real backend
    // config. This override is not on the CLI generation path (TopoGenerator
    // emits everything itself); keeping it in lockstep stops the two
    // definitions from silently disagreeing.
    return "[project]\n"
           "name = \"" + projectName + "\"\n"
           "\n"
           "[topo]\n"
           "root = \"topo/main.topo\"\n"
           "\n"
           "[build]\n"
           "language = \"typescript\"\n"
           "sources = [\"" + sourceFileGlob() + "\"]\n"
           "output = \"" + projectName + "\"\n"
           "\n"
           "[completeness]\n"
           "ignore_main = true\n"
           "\n"
           "[build.backendExtras]\n"
           "nodePath = \"node\"\n"
           "tsconfigPath = \"./tsconfig.json\"\n";
}

std::string TypeScriptInitTemplateProvider::generateTypeBindings() const {
    // Match TopoGenerator's TypeScript bindings exactly: alias the TS type
    // names (number/string/boolean) to the std::typescript bridge namespace.
    // The previous spelling aliased C++/Python-style names (int/float/bool/str)
    // to std::typescript::*, which neither TopoGenerator nor the V8 codegen
    // resolve — e.g. `using int = std::typescript::number` instead of the
    // correct `using number = std::typescript::number`.
    return "using number = std::typescript::number;\n"
           "using string = std::typescript::string;\n"
           "using boolean = std::typescript::boolean;\n";
}

} // namespace topo::lang
