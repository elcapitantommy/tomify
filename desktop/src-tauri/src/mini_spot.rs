// Where the mini player goes on screen. Kept free of Tauri so it can be tested on any machine.
// Positions are physical pixels (Windows desktop coordinates), the same as Tauri's outer_position().

/// A monitor's work area (the screen minus the taskbar) and its scale factor.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub scale: f64,
}

/// The mini player's size and its gap from the screen edge, in logical pixels.
pub const MINI_WIDTH: f64 = 360.0;
pub const MINI_HEIGHT: f64 = 168.0;
pub const MINI_MARGIN: f64 = 16.0;

fn mini_size(area: &Area) -> (i32, i32) {
    ((MINI_WIDTH * area.scale).round() as i32, (MINI_HEIGHT * area.scale).round() as i32)
}

/// Bottom right of the area, above the taskbar: where the mini player opens the first time.
pub fn default_spot(area: &Area) -> (i32, i32) {
    let (width, height) = mini_size(area);
    let margin = (MINI_MARGIN * area.scale).round() as i32;
    (area.x + area.width - width - margin, area.y + area.height - height - margin)
}

// Measured at one size for every monitor, so a high-DPI screen doesn't win just by making the window bigger.
fn overlap(spot: (i32, i32), area: &Area) -> i64 {
    let (width, height) = (MINI_WIDTH as i32, MINI_HEIGHT as i32);
    let w = (spot.0 + width).min(area.x + area.width) - spot.0.max(area.x);
    let h = (spot.1 + height).min(area.y + area.height) - spot.1.max(area.y);
    if w <= 0 || h <= 0 { 0 } else { w as i64 * h as i64 }
}

fn distance(spot: (i32, i32), area: &Area) -> i64 {
    let dx = (area.x - spot.0).max(spot.0 - (area.x + area.width)).max(0) as i64;
    let dy = (area.y - spot.1).max(spot.1 - (area.y + area.height)).max(0) as i64;
    dx * dx + dy * dy
}

fn clamp_into(spot: (i32, i32), area: &Area) -> (i32, i32) {
    let (width, height) = mini_size(area);
    let x = spot.0.min(area.x + area.width - width).max(area.x);
    let y = spot.1.min(area.y + area.height - height).max(area.y);
    (x, y)
}

/// Where to open the mini player: the last place it was left, moved just far enough to be fully on
/// the monitor it mostly sits on (or the nearest one, if that monitor has gone), or the default spot
/// on `current` when there is no saved place or no monitors are known.
pub fn place(saved: Option<(i32, i32)>, current: &Area, areas: &[Area]) -> (i32, i32) {
    let Some(spot) = saved else { return default_spot(current) };
    let best = areas
        .iter()
        .max_by_key(|area| overlap(spot, area))
        .filter(|area| overlap(spot, area) > 0)
        .or_else(|| areas.iter().min_by_key(|area| distance(spot, area)));
    match best {
        Some(area) => clamp_into(spot, area),
        None => default_spot(current),
    }
}

/// The saved place on disk is one line: "x,y".
pub fn parse(text: &str) -> Option<(i32, i32)> {
    let (x, y) = text.trim().split_once(',')?;
    Some((x.trim().parse().ok()?, y.trim().parse().ok()?))
}

pub fn format(spot: (i32, i32)) -> String {
    format!("{},{}", spot.0, spot.1)
}

/// Windows parks minimised windows at -32000; that is never a place to remember.
pub fn worth_saving(spot: (i32, i32)) -> bool {
    spot.0 > -30000 && spot.1 > -30000
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEFT: Area = Area { x: 0, y: 0, width: 1920, height: 1040, scale: 1.0 };
    // A 4K screen at 150% to the right of it.
    const RIGHT: Area = Area { x: 1920, y: 0, width: 3840, height: 2080, scale: 1.5 };

    #[test]
    fn first_time_it_opens_bottom_right_above_the_taskbar() {
        assert_eq!(place(None, &LEFT, &[LEFT, RIGHT]), (1920 - 360 - 16, 1040 - 168 - 16));
        assert_eq!(place(None, &RIGHT, &[LEFT, RIGHT]), (1920 + 3840 - 540 - 24, 2080 - 252 - 24));
    }

    #[test]
    fn a_saved_place_that_is_on_screen_is_kept() {
        assert_eq!(place(Some((40, 60)), &LEFT, &[LEFT, RIGHT]), (40, 60));
        assert_eq!(place(Some((3000, 900)), &LEFT, &[LEFT, RIGHT]), (3000, 900));
    }

    #[test]
    fn a_place_hanging_off_the_edge_is_pulled_back_on() {
        assert_eq!(place(Some((1800, 1000)), &LEFT, &[LEFT]), (1920 - 360, 1040 - 168));
        assert_eq!(place(Some((-100, -50)), &LEFT, &[LEFT]), (0, 0));
    }

    #[test]
    fn straddling_two_monitors_it_moves_onto_the_one_it_mostly_covers() {
        // Mostly on the right-hand monitor.
        assert_eq!(place(Some((1900, 500)), &LEFT, &[LEFT, RIGHT]), (1920, 500));
        // Mostly on the left-hand one.
        assert_eq!(place(Some((1700, 500)), &LEFT, &[LEFT, RIGHT]), (1920 - 360, 500));
    }

    #[test]
    fn a_place_on_an_unplugged_monitor_moves_to_the_nearest_one() {
        assert_eq!(place(Some((3000, 900)), &LEFT, &[LEFT]), (1920 - 360, 900 - 28));
        assert_eq!(place(Some((-2500, 300)), &LEFT, &[LEFT]), (0, 300));
    }

    #[test]
    fn with_no_monitors_known_it_uses_the_default() {
        assert_eq!(place(Some((40, 60)), &LEFT, &[]), default_spot(&LEFT));
    }

    #[test]
    fn the_saved_file_round_trips_and_rejects_rubbish() {
        assert_eq!(parse(&format((-1200, 340))), Some((-1200, 340)));
        assert_eq!(parse(" 10 , 20 \n"), Some((10, 20)));
        assert_eq!(parse(""), None);
        assert_eq!(parse("10"), None);
        assert_eq!(parse("a,b"), None);
    }

    #[test]
    fn a_minimised_window_is_not_remembered() {
        assert!(!worth_saving((-32000, -32000)));
        assert!(worth_saving((-1200, 300)));
    }
}
