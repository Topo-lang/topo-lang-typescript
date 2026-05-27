#include "TypeScriptPlugin.h"
#include <gtest/gtest.h>

int main(int argc, char** argv) {
    topo::lang::registerTypeScriptPlugin();
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
