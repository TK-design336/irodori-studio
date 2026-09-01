// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Parakeet Inc.
// SegmentBuilder logic adapted from Parapper (https://github.com/parakeet-inc/Parapper).

mod buffer;
mod config;
mod facade;

pub(crate) use facade::{SegmentBuilder, SegmentBuilderEvent, SegmentCloseReason};
