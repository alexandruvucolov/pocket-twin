#include "audio2face/audio2face.h"
#include "audio2x/cuda_utils.h"

#include "AudioFile.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace fs = std::filesystem;

#define CHECK_RESULT(func)                                                     \
  {                                                                            \
    std::error_code error = (func);                                            \
    if (error) {                                                               \
      std::ostringstream message;                                              \
      message << "Failed to execute: " << #func                               \
              << ", reason: " << error.message();                             \
      throw std::runtime_error(message.str());                                 \
    }                                                                          \
  }

#define CHECK_ERROR(expression, message)                                       \
  {                                                                            \
    if (!(expression)) {                                                       \
      throw std::runtime_error(message);                                       \
    }                                                                          \
  }

struct Destroyer {
  template <typename T>
  void operator()(T* obj) const {
    if (obj) {
      obj->Destroy();
    }
  }
};

template <typename T>
using UniquePtr = std::unique_ptr<T, Destroyer>;

template <typename T>
UniquePtr<T> ToUniquePtr(T* ptr) {
  return UniquePtr<T>(ptr);
}

struct Args {
  std::string audioPath;
  std::string modelPath;
  std::string outputDir;
  std::string sessionId;
  std::string utterance;
};

struct FrameMotion {
  long long timeStampCurrentFrame{0};
  long long timeStampNextFrame{0};
  std::vector<float> jawTransform;
  float mouthOpen{0.0f};
};

struct CallbackData {
  std::size_t frameCount{0};
  std::vector<long long> timestamps;
  std::vector<long long> nextTimestamps;
  std::vector<FrameMotion> frames;
};

std::vector<float> CopyDeviceTensorToHost(nva2x::DeviceTensorFloatConstView source) {
  std::vector<float> host(source.Size(), 0.0f);
  if (!host.empty()) {
    CHECK_RESULT(nva2x::CopyDeviceToHost(
      nva2x::HostTensorFloatView{host.data(), host.size()},
      source
    ));
  }
  return host;
}

float ComputeMouthOpen(const std::vector<float>& jawTransform) {
  if (jawTransform.empty()) {
    return 0.0f;
  }

  static constexpr float identity[] = {
    1.0f, 0.0f, 0.0f, 0.0f,
    0.0f, 1.0f, 0.0f, 0.0f,
    0.0f, 0.0f, 1.0f, 0.0f,
    0.0f, 0.0f, 0.0f, 1.0f,
  };

  const std::size_t sampleCount = std::min<std::size_t>(jawTransform.size(), 16);
  float deltaSum = 0.0f;
  for (std::size_t i = 0; i < sampleCount; ++i) {
    deltaSum += std::fabs(jawTransform[i] - identity[i]);
  }

  const float translationY = jawTransform.size() > 13 ? std::fabs(jawTransform[13]) : 0.0f;
  const float translationZ = jawTransform.size() > 14 ? std::fabs(jawTransform[14]) : 0.0f;
  const float normalized = (deltaSum / static_cast<float>(sampleCount)) * 4.0f
    + translationY * 30.0f
    + translationZ * 20.0f;
  return std::clamp(normalized, 0.0f, 1.0f);
}

std::string JsonEscape(const std::string& value) {
  std::ostringstream out;
  for (char c : value) {
    switch (c) {
      case '\\': out << "\\\\"; break;
      case '"': out << "\\\""; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default: out << c; break;
    }
  }
  return out.str();
}

bool StartsWith(std::string_view value, std::string_view prefix) {
  return value.substr(0, prefix.size()) == prefix;
}

Args ParseArgs(int argc, char** argv) {
  Args args;
  for (int i = 1; i < argc; ++i) {
    const std::string current = argv[i];
    auto takeValue = [&](const char* name) -> std::string {
      if (i + 1 >= argc) {
        std::ostringstream err;
        err << "Missing value after " << name;
        throw std::runtime_error(err.str());
      }
      return argv[++i];
    };

    if (current == "--audio") {
      args.audioPath = takeValue("--audio");
    } else if (current == "--model") {
      args.modelPath = takeValue("--model");
    } else if (current == "--output") {
      args.outputDir = takeValue("--output");
    } else if (current == "--session") {
      args.sessionId = takeValue("--session");
    } else if (current == "--utterance") {
      args.utterance = takeValue("--utterance");
    } else if (StartsWith(current, "--audio=")) {
      args.audioPath = current.substr(8);
    } else if (StartsWith(current, "--model=")) {
      args.modelPath = current.substr(8);
    } else if (StartsWith(current, "--output=")) {
      args.outputDir = current.substr(9);
    } else if (StartsWith(current, "--session=")) {
      args.sessionId = current.substr(10);
    } else if (StartsWith(current, "--utterance=")) {
      args.utterance = current.substr(12);
    } else if (current == "--help" || current == "-h") {
      std::cout
        << "Usage: pocket-twin-a2f-bridge --audio file.wav --model model.json --output folder [--session id] [--utterance n]"
        << std::endl;
      std::exit(0);
    } else {
      std::ostringstream err;
      err << "Unknown argument: " << current;
      throw std::runtime_error(err.str());
    }
  }
  return args;
}

std::vector<float> ReadAudio(std::string_view audioFilePath) {
  AudioFile<float> audioFile;
  CHECK_ERROR(audioFile.load(audioFilePath.data()), "Unable to load audio file");
  CHECK_ERROR(audioFile.getNumChannels() >= 1, "Audio file must have at least one channel");
  CHECK_ERROR(audioFile.getSampleRate() == 16000, "Audio file must be 16kHz");
  return audioFile.samples[0];
}

void AddDefaultEmotion(nva2f::IGeometryExecutorBundle& bundle) {
  const auto nbTracks = bundle.GetExecutor().GetNbTracks();
  std::vector<float> emptyEmotion;
  for (std::size_t trackIndex = 0; trackIndex < nbTracks; ++trackIndex) {
    auto& emotionAccumulator = bundle.GetEmotionAccumulator(trackIndex);
    emptyEmotion.assign(emotionAccumulator.GetEmotionSize(), 0.0f);
    CHECK_RESULT(emotionAccumulator.Accumulate(
      0,
      nva2x::HostTensorFloatConstView{emptyEmotion.data(), emptyEmotion.size()},
      bundle.GetCudaStream().Data()
    ));
    CHECK_RESULT(emotionAccumulator.Close());
  }
}

UniquePtr<nva2f::IGeometryExecutorBundle> CreateBundle(const std::string& modelPath, std::string& modelType) {
  auto regression = ToUniquePtr(
    nva2f::ReadRegressionGeometryExecutorBundle(
      1,
      modelPath.c_str(),
      nva2f::IGeometryExecutor::ExecutionOption::All,
      60,
      1,
      nullptr
    )
  );
  if (regression) {
    modelType = "regression";
    return regression;
  }

  auto diffusion = ToUniquePtr(
    nva2f::ReadDiffusionGeometryExecutorBundle(
      1,
      modelPath.c_str(),
      nva2f::IGeometryExecutor::ExecutionOption::All,
      0,
      false,
      nullptr
    )
  );
  if (diffusion) {
    modelType = "diffusion";
    return diffusion;
  }

  return {};
}

void WriteJsonSummary(
  const fs::path& outputPath,
  const Args& args,
  const std::string& modelType,
  const CallbackData& callbackData,
  std::size_t audioSamples,
  std::size_t skinGeometrySize,
  std::size_t tongueGeometrySize,
  std::size_t jawTransformSize,
  std::size_t eyesRotationSize,
  double elapsedMs
) {
  std::ofstream out(outputPath);
  out << "{\n";
  out << "  \"ok\": true,\n";
  out << "  \"sessionId\": \"" << JsonEscape(args.sessionId) << "\",\n";
  out << "  \"utterance\": \"" << JsonEscape(args.utterance) << "\",\n";
  out << "  \"audioPath\": \"" << JsonEscape(args.audioPath) << "\",\n";
  out << "  \"modelPath\": \"" << JsonEscape(args.modelPath) << "\",\n";
  out << "  \"modelType\": \"" << JsonEscape(modelType) << "\",\n";
  out << "  \"audioSamples\": " << audioSamples << ",\n";
  out << "  \"frameCount\": " << callbackData.frameCount << ",\n";
  out << "  \"elapsedMs\": " << std::fixed << std::setprecision(3) << elapsedMs << ",\n";
  out << "  \"skinGeometrySize\": " << skinGeometrySize << ",\n";
  out << "  \"tongueGeometrySize\": " << tongueGeometrySize << ",\n";
  out << "  \"jawTransformSize\": " << jawTransformSize << ",\n";
  out << "  \"eyesRotationSize\": " << eyesRotationSize << ",\n";
  out << "  \"timestamps\": [";
  for (std::size_t i = 0; i < callbackData.timestamps.size(); ++i) {
    if (i) out << ", ";
    out << callbackData.timestamps[i];
  }
  out << "],\n";
  out << "  \"nextTimestamps\": [";
  for (std::size_t i = 0; i < callbackData.nextTimestamps.size(); ++i) {
    if (i) out << ", ";
    out << callbackData.nextTimestamps[i];
  }
  out << "]\n";
  out << "}\n";
}

void WriteMotionJson(const fs::path& outputPath, const CallbackData& callbackData) {
  std::ofstream out(outputPath);
  out << "{\n";
  out << "  \"ok\": true,\n";
  out << "  \"frameCount\": " << callbackData.frames.size() << ",\n";
  out << "  \"frames\": [\n";
  for (std::size_t i = 0; i < callbackData.frames.size(); ++i) {
    const auto& frame = callbackData.frames[i];
    out << "    {\n";
    out << "      \"timeMs\": " << frame.timeStampCurrentFrame << ",\n";
    out << "      \"nextTimeMs\": " << frame.timeStampNextFrame << ",\n";
    out << "      \"mouthOpen\": " << std::fixed << std::setprecision(6) << frame.mouthOpen << ",\n";
    out << "      \"jawTransform\": [";
    for (std::size_t j = 0; j < frame.jawTransform.size(); ++j) {
      if (j) out << ", ";
      out << frame.jawTransform[j];
    }
    out << "]\n";
    out << "    }" << (i + 1 == callbackData.frames.size() ? "\n" : ",\n");
  }
  out << "  ]\n";
  out << "}\n";
}

int main(int argc, char** argv) {
  try {
    const auto args = ParseArgs(argc, argv);
    CHECK_ERROR(!args.audioPath.empty(), "Missing --audio");
    CHECK_ERROR(!args.modelPath.empty(), "Missing --model");
    CHECK_ERROR(!args.outputDir.empty(), "Missing --output");

    CHECK_RESULT(nva2x::SetCudaDeviceIfNeeded(0));

    fs::create_directories(args.outputDir);
    const auto audioBuffer = ReadAudio(args.audioPath);
    CHECK_ERROR(!audioBuffer.empty(), "Audio file is empty");

    std::string modelType;
    auto bundle = CreateBundle(args.modelPath, modelType);
    CHECK_ERROR(bundle != nullptr, "Unable to load Audio2Face model as regression or diffusion bundle");

    AddDefaultEmotion(*bundle);

    CallbackData callbackData;
    auto callback = [](void* userdata, const nva2f::IGeometryExecutor::Results& results) {
      auto& data = *static_cast<CallbackData*>(userdata);
      data.frameCount += 1;
      data.timestamps.push_back(static_cast<long long>(results.timeStampCurrentFrame));
      data.nextTimestamps.push_back(static_cast<long long>(results.timeStampNextFrame));
      auto jawTransform = CopyDeviceTensorToHost(results.jawTransform);
      data.frames.push_back(FrameMotion{
        static_cast<long long>(results.timeStampCurrentFrame),
        static_cast<long long>(results.timeStampNextFrame),
        std::move(jawTransform),
        0.0f
      });
      auto& frame = data.frames.back();
      frame.mouthOpen = ComputeMouthOpen(frame.jawTransform);
      return true;
    };
    CHECK_RESULT(bundle->GetExecutor().SetResultsCallback(callback, &callbackData));

    auto& audioAccumulator = bundle->GetAudioAccumulator(0);
    CHECK_RESULT(audioAccumulator.Accumulate(
      nva2x::HostTensorFloatConstView{audioBuffer.data(), audioBuffer.size()},
      bundle->GetCudaStream().Data()
    ));
    CHECK_RESULT(audioAccumulator.Close());

    const auto start = std::chrono::steady_clock::now();
    while (nva2x::GetNbReadyTracks(bundle->GetExecutor()) > 0) {
      std::size_t nbExecutedTracks = 0;
      CHECK_RESULT(bundle->GetExecutor().Execute(&nbExecutedTracks));
      if (nbExecutedTracks == 0) {
        break;
      }
    }
    CHECK_RESULT(bundle->GetCudaStream().Synchronize());
    const auto end = std::chrono::steady_clock::now();
    const auto elapsedMs = std::chrono::duration<double, std::milli>(end - start).count();

    WriteJsonSummary(
      fs::path(args.outputDir) / "a2f-summary.json",
      args,
      modelType,
      callbackData,
      audioBuffer.size(),
      bundle->GetExecutor().GetSkinGeometrySize(),
      bundle->GetExecutor().GetTongueGeometrySize(),
      bundle->GetExecutor().GetJawTransformSize(),
      bundle->GetExecutor().GetEyesRotationSize(),
      elapsedMs
    );
    WriteMotionJson(fs::path(args.outputDir) / "a2f-motion.json", callbackData);

    std::cout << "Bridge completed. Frames: " << callbackData.frameCount << std::endl;
    return 0;
  } catch (const std::exception& exc) {
    std::cerr << "Error: " << exc.what() << std::endl;
    return 1;
  }
}
