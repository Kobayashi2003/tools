using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Collections.Specialized;
using System.ComponentModel;

namespace QuickLook.Plugin.FolderViewer;

/// <summary>
/// An ObservableCollection whose range operations raise one Reset instead of one event per item,
/// which keeps expanding a folder of 100,000 entries instant.
/// </summary>
internal sealed class BulkObservableCollection<T> : ObservableCollection<T>
{
    // Below this, per-item events are cheap and keep the ListView's selection and scroll undisturbed.
    private const int ResetThreshold = 64;

    private List<T> List => (List<T>)Items;

    public void InsertRange(int index, IReadOnlyList<T> items)
    {
        if (items.Count <= ResetThreshold)
        {
            for (var i = 0; i < items.Count; i++)
                InsertItem(index + i, items[i]);
            return;
        }

        CheckReentrancy();
        List.InsertRange(index, items);
        RaiseReset();
    }

    public void RemoveRange(int index, int count)
    {
        if (count <= ResetThreshold)
        {
            for (var i = 0; i < count; i++)
                RemoveItem(index);
            return;
        }

        CheckReentrancy();
        List.RemoveRange(index, count);
        RaiseReset();
    }

    public void ReplaceAll(IEnumerable<T> items)
    {
        CheckReentrancy();
        List.Clear();
        List.AddRange(items);
        RaiseReset();
    }

    private void RaiseReset()
    {
        OnPropertyChanged(new PropertyChangedEventArgs(nameof(Count)));
        OnPropertyChanged(new PropertyChangedEventArgs("Item[]"));
        OnCollectionChanged(new NotifyCollectionChangedEventArgs(NotifyCollectionChangedAction.Reset));
    }
}
