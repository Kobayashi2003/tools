using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using UsageOrb.Core;

namespace UsageOrb.UI.Controls;

/// <summary>
/// Renders an exact 100-cell (20x5) proportional context window grid.
/// Each rounded cell represents 1% of the active model's context ceiling.
/// </summary>
public sealed class ContextGridControl : Grid
{
    public void Update(IReadOnlyList<ContextCategoryItem> categories, long contextWindowSize)
    {
        Children.Clear();
        RowDefinitions.Clear();
        ColumnDefinitions.Clear();

        const int cols = 20;
        const int rows = 5;
        const int totalCells = cols * rows;

        for (int r = 0; r < rows; r++) RowDefinitions.Add(new RowDefinition { Height = new GridLength(20) });
        for (int c = 0; c < cols; c++) ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        var cells = new List<(System.Windows.Media.Brush Fill, bool Filled, string Tooltip)>(totalCells);
        var freeBrush = TryFindResource("TrackBrush") as System.Windows.Media.Brush
                        ?? new SolidColorBrush(System.Windows.Media.Color.FromRgb(36, 42, 56));
        var borderBrush = TryFindResource("BorderSubtleBrush") as System.Windows.Media.Brush
                          ?? new SolidColorBrush(System.Windows.Media.Color.FromRgb(44, 52, 68));

        var conv = new BrushConverter();
        foreach (var cat in categories)
        {
            if (cat.Tokens <= 0) continue;
            double raw = (double)cat.Tokens / Math.Max(1, contextWindowSize) * totalCells;
            int count = Math.Max(raw >= 0.35 ? 1 : 0, (int)Math.Round(raw));
            var brush = (System.Windows.Media.Brush)conv.ConvertFromString(cat.ColorHex)!;
            var tip = $"{cat.Label}: {FormatUtil.Tokens(cat.Tokens)} ({cat.PercentageOfWindow:F1}% of window)";

            for (int i = 0; i < count && cells.Count < totalCells; i++)
            {
                cells.Add((brush, true, tip));
            }
        }

        while (cells.Count < totalCells)
        {
            cells.Add((freeBrush, false, $"Free context capacity ({FormatUtil.Tokens(contextWindowSize)} limit)"));
        }

        for (int i = 0; i < totalCells; i++)
        {
            var cell = cells[i];
            var rect = new Border
            {
                Background = cell.Fill,
                BorderBrush = cell.Filled ? System.Windows.Media.Brushes.Transparent : borderBrush,
                BorderThickness = cell.Filled ? new Thickness(0) : new Thickness(0.75),
                CornerRadius = new CornerRadius(3.5),
                Margin = new Thickness(2),
                ToolTip = cell.Tooltip,
            };
            SetRow(rect, i / cols);
            SetColumn(rect, i % cols);
            Children.Add(rect);
        }
    }
}
