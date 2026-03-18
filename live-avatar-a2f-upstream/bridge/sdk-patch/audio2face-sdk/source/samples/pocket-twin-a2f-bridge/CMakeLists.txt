add_executable(pocket-twin-a2f-bridge)

set_target_properties(pocket-twin-a2f-bridge PROPERTIES
    ARCHIVE_OUTPUT_DIRECTORY ${A2F_BINARY_DIR}/lib
    LIBRARY_OUTPUT_DIRECTORY ${A2F_BINARY_DIR}/lib
    RUNTIME_OUTPUT_DIRECTORY ${A2F_BINARY_DIR}/bin
    VS_DEBUGGER_ENVIRONMENT "PATH=%PATH%;${TENSORRT_ROOT_DIR}/lib;${CUDA_PATH}/bin;$<TARGET_FILE_DIR:audio2x>"
    VS_DEBUGGER_WORKING_DIRECTORY ${AUDIO2X_SDK_ROOT}
)

target_sources(pocket-twin-a2f-bridge PRIVATE
    main.cpp
)

target_compile_definitions(pocket-twin-a2f-bridge PRIVATE
    TEST_DATA_DIR="${TEST_DATA_DIR}"
)

target_link_libraries(pocket-twin-a2f-bridge PRIVATE
    audio2x
    AudioFile::AudioFile
)
