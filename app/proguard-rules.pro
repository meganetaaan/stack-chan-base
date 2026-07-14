# Piper Plus is loaded reflectively so R8 must retain its public API when the AAR is present.
-keep class com.piperplus.** { *; }
