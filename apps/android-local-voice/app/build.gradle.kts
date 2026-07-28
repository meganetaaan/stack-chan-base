plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.kotlin.serialization)
}

val piperAar = file("libs/piper-plus-release.aar")

android {
    namespace = "jp.stackchan.localvoicepoc"
    compileSdk = 37

    defaultConfig {
        applicationId = "jp.stackchan.localvoicepoc"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0-poc"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("boolean", "PIPER_PLUS_AAR_PRESENT", piperAar.exists().toString())

        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    sourceSets {
        getByName("test") {
            resources.directories.add(rootProject.file("../../contracts/usb-cdc-v2").path)
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
            excludes += setOf(
                "/debian-*/**",
                "/macos-*/**",
                "/win-*/**",
            )
        }
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    if (piperAar.exists()) {
        implementation(files(piperAar))
    }

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.lifecycle.viewmodel.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.documentfile)
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.kotlinx.coroutines.android)

    implementation(libs.runanywhere.sdk)
    implementation(libs.runanywhere.onnx)
    implementation(libs.runanywhere.llamacpp)
    implementation(libs.litert.lm)
    implementation(libs.webrtc.vad)
    implementation(libs.usb.serial)
    implementation(libs.compose.icons.lucide)
    implementation(libs.mcp.kotlin.client)
    implementation(libs.ktor.client.cio)
    implementation(libs.kotlinx.serialization.json)

    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
