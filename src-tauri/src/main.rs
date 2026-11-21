// ArkNetzWebWeaver — desktop entry point. The whole shell lives in
// src/lib.rs so the Android target can build it as a cdylib; this
// binary is a one-line wrapper around `run()`.
fn main() {
    arknetzwebweaver_lib::run();
}
