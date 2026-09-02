// Windows でコンソールウィンドウを出さない
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    manga_organizer_desktop_lib::run()
}
